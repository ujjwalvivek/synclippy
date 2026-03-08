package main

import (
	"bytes"
	"crypto/rand"
	"embed"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

//go:embed all:dist
var embedFS embed.FS

//go:embed wordlist.txt
var wordlistRaw string

// ? configuration constants; tune these for different deployment profiles
const (
	// ? how long rooms stay alive after creation
	roomTTL = 5 * time.Minute
	// ? how long uploaded files remain available (shorter than rooms)
	fileTTL = 1 * time.Minute
	// ? websocket payload limit to protect against memory blowup
	maxMessageSize = 52 << 20 //* 52 MB WS read limit
	// ? per-upload size cap enforced by both client and server
	maxFileSize = 50 << 20 //* 50 MB per file
	// ? total bytes allowed in a room across all files
	maxRoomStorage = 250 << 20 //* 250 MB per room
	// ? limit number of files per room to avoid abuse
	maxRoomFiles = 5 //* max files per room
	// ? cap total uploads per room lifetime to prevent hammering
	maxRoomUploads = 20 //* regardless of deletes
	// ? size of buffered channel on client struct for outgoing messages
	clientChanSize = 64
	// ? simple rate limit for uploads (IP-based)
	uploadRateMax = 3 //* per IP per minute
)

// ? UploadedFile holds metadata for an uploaded file kept in memory.
// * The actual bytes are stored separately; this struct is serialized to the
// * client to inform editors about available downloads and expiration times.
type UploadedFile struct {
	Filename  string `json:"filename"`
	URL       string `json:"url"`
	SizeBytes int64  `json:"sizeBytes"`
	DeleteAt  int64  `json:"deleteAt"`
}

// ? client wraps a websocket connection with a buffered send channel.
// * The channel decouples goroutine writing from the reader goroutine so one
// * slow client doesn't block the entire room.
type client struct {
	conn      *websocket.Conn
	send      chan []byte
	closeOnce sync.Once
}

// ? room holds all state for one ephemeral session.
// * It is protected by an internal RWMutex for concurrent access from HTTP
// * handlers and WebSocket reader/writer goroutines.
type room struct {
	id          string
	createdAt   time.Time
	mu          sync.RWMutex
	noteContent string
	clients     map[*client]bool
	files       map[string]UploadedFile
	fileData    map[string][]byte
	fileCounter int
	uploadCount int
}

// ? calculate total size of all files in the room; used when enforcing
// ? the room storage limit.
func (r *room) totalBytes() int64 {
	var total int64
	for _, d := range r.fileData {
		total += int64(len(d))
	}
	return total
}

// ? send a JSON-serializable object to every client in the room except
// ? optionally the originator of a message.
func (r *room) broadcastJSON(payload interface{}, except *client) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	for c := range r.clients {
		if c == except {
			continue
		}
		select {
		case c.send <- data:
		default:
			log.Printf("room %s: dropping message for slow client", r.id)
		}
	}
}

// ? rooms is the global map of active rooms.
var (
	rooms   = make(map[string]*room)
	roomsMu sync.RWMutex
)

// ? wordlist is loaded once from the embedded file.
var wordlist []string

// ? rateLimit tracks upload counts per IP per minute window.
var (
	rateMu    sync.Mutex
	rateTable = make(map[string][]time.Time)
)

// ? keeps a slice of timestamps for each IP and prunes entries older than
// ? one minute before checking the quota.
func checkUploadRate(ip string) bool {
	now := time.Now()
	cutoff := now.Add(-time.Minute)
	rateMu.Lock()
	defer rateMu.Unlock()
	times := rateTable[ip]
	valid := times[:0]
	for _, t := range times {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}
	if len(valid) >= uploadRateMax {
		rateTable[ip] = valid
		return false
	}
	rateTable[ip] = append(valid, now)
	return true
}

func loadWordlist() {
	lines := strings.Split(strings.TrimSpace(wordlistRaw), "\n")
	for _, l := range lines {
		w := strings.TrimSpace(l)
		if w != "" {
			wordlist = append(wordlist, w)
		}
	}
	log.Printf("Loaded %d words in wordlist", len(wordlist))
}

// ? generate a random room ID composed of three words from the wordlist
// ? using crypto/rand for unpredictability.
func randomRoomID() (string, error) {
	n := len(wordlist)
	if n == 0 {
		return "", fmt.Errorf("empty wordlist")
	}
	pick := func() (string, error) {
		var buf [4]byte
		if _, err := rand.Read(buf[:]); err != nil {
			return "", err
		}
		idx := int(binary.BigEndian.Uint32(buf[:]) % uint32(n))
		return wordlist[idx], nil
	}
	w1, err := pick()
	if err != nil {
		return "", err
	}
	w2, err := pick()
	if err != nil {
		return "", err
	}
	w3, err := pick()
	if err != nil {
		return "", err
	}
	return w1 + "-" + w2 + "-" + w3, nil
}

// ? getRoom looks up an active (non-expired) room by ID.
// * (cleanupLoop handles eviction)
func getRoom(id string) (*room, bool) {
	roomsMu.RLock()
	r, ok := rooms[id]
	roomsMu.RUnlock()
	if !ok {
		return nil, false
	}
	if time.Since(r.createdAt) > roomTTL {
		return nil, false
	}
	return r, true
}

// ? cleanupLoop runs in its own goroutine and periodically evicts rooms
// ? that have surpassed the TTL.
func cleanupLoop() {
	for range time.Tick(30 * time.Second) {
		now := time.Now()
		roomsMu.Lock()
		for id, r := range rooms {
			if now.Sub(r.createdAt) > roomTTL {
				r.mu.Lock()
				for c := range r.clients {
					c.closeOnce.Do(func() { close(c.send) })
					delete(r.clients, c)
				}
				r.mu.Unlock()
				delete(rooms, id)
				log.Printf("Evicted expired room %s", id)
			} else {
				// ? sweep individual files whose TTL has passed within a still-live room
				fileNowMs := now.UnixMilli()
				r.mu.Lock()
				for name, meta := range r.files {
					if fileNowMs > meta.DeleteAt {
						delete(r.files, name)
						delete(r.fileData, name)
					}
				}
				r.mu.Unlock()
			}
		}
		roomsMu.Unlock()

		// ? prune stale entries from the upload rate-limit table
		cutoff := now.Add(-time.Minute)
		rateMu.Lock()
		for ip, times := range rateTable {
			valid := times[:0]
			for _, t := range times {
				if t.After(cutoff) {
					valid = append(valid, t)
				}
			}
			if len(valid) == 0 {
				delete(rateTable, ip)
			} else {
				rateTable[ip] = valid
			}
		}
		rateMu.Unlock()
	}
}

// ? startup sequence and HTTP server setup.
// * - Loads the wordlist,
// * - starts the cleanup loop,
// * - sets up routes,
// * - static file serving,
// * - listens on the configured port.
func main() {
	loadWordlist()
	go cleanupLoop()

	mime.AddExtensionType(".js", "application/javascript")
	mime.AddExtensionType(".mjs", "application/javascript")
	mime.AddExtensionType(".css", "text/css")
	mime.AddExtensionType(".svg", "image/svg+xml")

	mux := http.NewServeMux()

	mux.HandleFunc("/healthz", healthzHandler)
	mux.HandleFunc("/api/room/new", corsMiddleware(newRoomHandler))
	mux.HandleFunc("/api/note", corsMiddleware(noteHandler))
	mux.HandleFunc("/api/upload", corsMiddleware(uploadHandler))
	mux.HandleFunc("/api/files/", corsMiddleware(fileDownloadHandler))
	mux.HandleFunc("/api/files", corsMiddleware(fileListHandler))
	mux.HandleFunc("/ws", wsHandler)

	subFS, err := fs.Sub(embedFS, "dist")
	if err != nil {
		log.Fatal("embed sub failed:", err)
	}
	staticServer := http.FileServer(http.FS(subFS))
	indexHTML, _ := fs.ReadFile(subFS, "index.html")

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// ? Serves immutable assets with long cache headers.
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path != "" {
			f, err := subFS.Open(path)
			if err == nil {
				f.Close()
				if strings.HasPrefix(path, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				staticServer.ServeHTTP(w, r)
				return
			}
			if strings.HasPrefix(path, "assets/") {
				http.NotFound(w, r)
				return
			}
		}
		if len(indexHTML) > 0 {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(indexHTML))
		} else {
			staticServer.ServeHTTP(w, r)
		}
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	addr := ":" + port
	log.Printf("synclippy running on http://localhost%s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

// ? GET /healthz used by Docker HEALTHCHECK, k8s liveness probes, uptime monitors.
func healthzHandler(w http.ResponseWriter, r *http.Request) {
	// mirror the CORS policy used by the API endpoints so the browser
	// can successfully probe the service from a different origin.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ok"}`))
}

// ? simple CORS wrapper applied to all API endpoints to allow cross-origin
// ? use from the browser. also disables caching of dynamic API responses.
func corsMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Cache-Control", "no-store")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		next(w, r)
	}
}

// ? GET /api/room/new
// * returns JSON containing the ID and expiration timestamp.
func newRoomHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", 405)
		return
	}
	id, err := randomRoomID()
	if err != nil {
		http.Error(w, "Failed to generate room ID", 500)
		return
	}
	// ? Retry on collision (extremely unlikely)
	roomsMu.RLock()
	_, exists := rooms[id]
	roomsMu.RUnlock()
	if exists {
		id, err = randomRoomID()
		if err != nil {
			http.Error(w, "Failed to generate room ID", 500)
			return
		}
	}

	r2 := &room{
		id:        id,
		createdAt: time.Now(),
		clients:   make(map[*client]bool),
		files:     make(map[string]UploadedFile),
		fileData:  make(map[string][]byte),
	}
	roomsMu.Lock()
	rooms[id] = r2
	roomsMu.Unlock()

	log.Printf("Created room %s", id)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"roomId":    id,
		"expiresAt": r2.createdAt.Add(roomTTL).UnixMilli(),
	})
}

// ? noteHandler handles GET/POST for /api/note?room=ID
// * All access is synchronized with the room mutex.
func noteHandler(w http.ResponseWriter, r *http.Request) {
	rm, ok := roomFromQuery(w, r)
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		rm.mu.RLock()
		content := rm.noteContent
		rm.mu.RUnlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"content": content})
	case http.MethodPost:
		var req struct {
			Content string `json:"content"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, maxMessageSize)).Decode(&req); err != nil {
			http.Error(w, "Invalid JSON", 400)
			return
		}
		rm.mu.Lock()
		rm.noteContent = req.Content
		rm.mu.Unlock()
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// ? uploadHandler handles POST /api/upload?room=ID
// * performs rate limiting, size checks, enforces per-room quotas, stores
// * the file bytes in memory, and notifies other clients in the room.
func uploadHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", 405)
		return
	}
	rm, ok := roomFromQuery(w, r)
	if !ok {
		return
	}

	ip := clientIP(r)
	if !checkUploadRate(ip) {
		http.Error(w, "Too many uploads. Try again in a minute", http.StatusTooManyRequests)
		return
	}

	rm.mu.RLock()
	uploads := rm.uploadCount
	rm.mu.RUnlock()
	if uploads >= maxRoomUploads {
		http.Error(w, "Room upload limit reached", http.StatusTooManyRequests)
		return
	}

	if err := r.ParseMultipartForm(52 << 20); err != nil {
		http.Error(w, "Failed to parse form", 400)
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "No file in request", 400)
		return
	}
	defer file.Close()

	if header.Size > maxFileSize {
		http.Error(w, "File exceeds 50 MB limit", http.StatusRequestEntityTooLarge)
		return
	}

	data, err := io.ReadAll(io.LimitReader(file, maxFileSize+1))
	if err != nil {
		http.Error(w, "Failed to read file", 500)
		return
	}
	if int64(len(data)) > maxFileSize {
		http.Error(w, "File exceeds 50 MB limit", http.StatusRequestEntityTooLarge)
		return
	}

	rm.mu.Lock()
	if len(rm.files) >= maxRoomFiles {
		rm.mu.Unlock()
		http.Error(w, "Room file limit reached", http.StatusRequestEntityTooLarge)
		return
	}
	if rm.totalBytes()+int64(len(data)) > maxRoomStorage {
		rm.mu.Unlock()
		http.Error(w, "Room storage limit", http.StatusRequestEntityTooLarge)
		return
	}

	ext := filepath.Ext(header.Filename)
	if ext == "" {
		ext = ".bin"
	}
	rm.fileCounter++
	filename := fmt.Sprintf("file-%d%s", rm.fileCounter, ext)

	deleteAtMs := time.Now().Add(fileTTL).UnixMilli()
	meta := UploadedFile{
		Filename:  filename,
		URL:       "/api/files/" + rm.id + "/" + filename,
		SizeBytes: int64(len(data)),
		DeleteAt:  deleteAtMs,
	}
	rm.files[filename] = meta
	rm.fileData[filename] = data
	rm.uploadCount++
	rm.broadcastJSON(map[string]interface{}{
		"type": "file:added",
		"file": meta,
	}, nil)
	rm.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(meta)
}

// ? fileListHandler handles GET /api/files?room=ID
// * returns metadata about every file currently stored in the room.
func fileListHandler(w http.ResponseWriter, r *http.Request) {
	rm, ok := roomFromQuery(w, r)
	if !ok {
		return
	}
	rm.mu.RLock()
	nowMs := time.Now().UnixMilli()
	list := make([]UploadedFile, 0, len(rm.files))
	for _, m := range rm.files {
		if nowMs <= m.DeleteAt {
			list = append(list, m)
		}
	}
	rm.mu.RUnlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(list)
}

// ? fileDownloadHandler handles GET /api/files/{roomId}/{filename}
// * extracts the room and filename from the path, retrieves bytes from memory,
// * and streams them back to the client with appropriate headers.
func fileDownloadHandler(w http.ResponseWriter, r *http.Request) {
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/api/files/"), "/", 2)
	if len(parts) != 2 {
		http.Error(w, "Invalid path", 400)
		return
	}
	roomID := parts[0]
	filename := filepath.Base(parts[1])

	rm, ok := getRoom(roomID)
	if !ok {
		http.Error(w, "Room not found or expired", 404)
		return
	}

	rm.mu.RLock()
	meta, metaOk := rm.files[filename]
	data, ok := rm.fileData[filename]
	rm.mu.RUnlock()
	if !ok || !metaOk {
		http.Error(w, "File not found", 404)
		return
	}
	if time.Now().UnixMilli() > meta.DeleteAt {
		rm.mu.Lock()
		delete(rm.files, filename)
		delete(rm.fileData, filename)
		rm.mu.Unlock()
		http.Error(w, "File has expired", http.StatusGone)
		return
	}

	ctype := mime.TypeByExtension(filepath.Ext(filename))
	if ctype == "" {
		ctype = http.DetectContentType(data)
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename=%q`, filename))
	http.ServeContent(w, r, filename, time.Time{}, bytes.NewReader(data))
}

// ? writePump drains the send channel and writes to the WS connection.
func writePump(c *client) {
	defer c.conn.Close()
	for msg := range c.send {
		if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			return
		}
	}
}

// ? wsHandler handles WebSocket connections at /ws?room=ID
// * upgrades the HTTP request, registers the client with the room, sends an
// * initial sync message, and then loops reading incoming JSON messages.
func wsHandler(w http.ResponseWriter, r *http.Request) {
	roomID := r.URL.Query().Get("room")
	rm, ok := getRoom(roomID)
	if !ok {
		http.Error(w, `{"error":"room_expired"}`, 404)
		return
	}

	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(maxMessageSize)

	c := &client{
		conn: conn,
		send: make(chan []byte, clientChanSize),
	}

	rm.mu.Lock()
	rm.clients[c] = true
	rm.mu.Unlock()

	go writePump(c)

	// ? Send current state to new client
	rm.mu.RLock()
	currentNote := rm.noteContent
	wsNowMs := time.Now().UnixMilli()
	currentFiles := make([]UploadedFile, 0, len(rm.files))
	for _, m := range rm.files {
		if wsNowMs <= m.DeleteAt {
			currentFiles = append(currentFiles, m)
		}
	}
	expiresAt := rm.createdAt.Add(roomTTL).UnixMilli()
	rm.mu.RUnlock()

	initMsg, _ := json.Marshal(map[string]interface{}{
		"type":      "room:sync",
		"content":   currentNote,
		"files":     currentFiles,
		"expiresAt": expiresAt,
	})
	select {
	case c.send <- initMsg:
	default:
	}

	for {
		var rawMsg map[string]interface{}
		if err := conn.ReadJSON(&rawMsg); err != nil {
			break
		}

		msgType, _ := rawMsg["type"].(string)
		switch msgType {
		case "clipboard:share":
			text, _ := rawMsg["text"].(string)
			if len(text) > 1<<20 {
				continue
			}
			rm.broadcastJSON(map[string]interface{}{
				"type": "clipboard:share",
				"text": text,
			}, c)
		case "note:patch":
			content, _ := rawMsg["content"].(string)
			rm.mu.Lock()
			rm.noteContent = content
			rm.broadcastJSON(map[string]interface{}{
				"type":    "note:patch",
				"edits":   rawMsg["edits"],
				"content": content,
			}, c)
			rm.mu.Unlock()
		case "note:sync":
			content, _ := rawMsg["content"].(string)
			rm.mu.Lock()
			rm.noteContent = content
			rm.broadcastJSON(map[string]interface{}{
				"type":    "note:sync",
				"content": content,
			}, c)
			rm.mu.Unlock()
		}
	}

	rm.mu.Lock()
	delete(rm.clients, c)
	rm.mu.Unlock()
	c.closeOnce.Do(func() { close(c.send) })
}

// ? roomFromQuery extracts ?room=ID, validates it, and returns the room.
func roomFromQuery(w http.ResponseWriter, r *http.Request) (*room, bool) {
	id := r.URL.Query().Get("room")
	if id == "" {
		w.Header().Set("Content-Type", "application/json")
		http.Error(w, `{"error":"missing room param"}`, 400)
		return nil, false
	}
	rm, ok := getRoom(id)
	if !ok {
		w.Header().Set("Content-Type", "application/json")
		http.Error(w, `{"error":"room_expired"}`, 404)
		return nil, false
	}
	return rm, true
}

// ? clientIP extracts the real client IP from the request, preferring the
// ? X-Forwarded-For header when present (useful behind proxies).
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.SplitN(xff, ",", 2)[0]
	}
	ip := r.RemoteAddr
	if i := strings.LastIndex(ip, ":"); i > 0 {
		return ip[:i]
	}
	return ip
}
