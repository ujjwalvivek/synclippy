import { DurableObject } from 'cloudflare:workers'
import type { Env } from './index'
import wordlistRaw from '../wordlist.txt'

// ? constants must match Go server
const MAX_FILE_SIZE     = 50  * 1024 * 1024  // * 50 MB
const MAX_ROOM_STORAGE  = 250 * 1024 * 1024  // * 250 MB
const MAX_ROOM_FILES    = 5                  // * max files per room
const MAX_ROOM_UPLOADS  = 20                 // * total uploads per room lifetime (regardless of deletes)
const UPLOAD_RATE_MAX   = 3                  // * per IP per minute
const ROOM_TTL_MS       = 5 * 60 * 1000      // * 5 minutes
const TRIAL_ROOM_TTL_MS = 2 * 60 * 1000      // * 2 minutes (unauthenticated demo)
const FILE_TTL_MS       = 1 * 60 * 1000      // * 1 minute

interface UploadedFile {
  filename: string
  url:      string
  sizeBytes: number
  deleteAt:  number
}

const words = wordlistRaw.split(/\s+/).filter(Boolean)
const noStoreHeaders = (): HeadersInit => ({ 'Cache-Control': 'no-store' })

function randomIndex(max: number): number {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return buf[0] % max
}

// ? generates a 3-word hyphenated room ID using the same wordlist as the Go server.
export function generateRoomId(): string {
  const n = words.length
  return `${words[randomIndex(n)]}-${words[randomIndex(n)]}-${words[randomIndex(n)]}`
}

// ? room DO. one instance per room ID. stores note content and uploaded files in
// ? DO SQL. WS use the hibernation API so the DO can sleep between messages
// ? without dropping connections.
export class Room extends DurableObject<Env> {
  private noteContent   = ''
  private expiresAt     = 0
  private trialMode     = false
  private fileCounter   = 0
  // * in-memory rate table, acceptable for a personal tool.
  private uploadCounts  = new Map<string, number[]>()
  private uploadCount   = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // ? blockConcurrencyWhile runs before any fetch(), ensures state is loaded from storage.
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS files (
          filename  TEXT     PRIMARY KEY,
          url       TEXT     NOT NULL,
          size_bytes INTEGER NOT NULL,
          delete_at  INTEGER NOT NULL,
          data      BLOB     NOT NULL
        )
      `)
      // ? rehydrate in-memory state from KV storage
      this.noteContent  = (await this.ctx.storage.get<string>('noteContent'))  ?? ''
      this.expiresAt    = (await this.ctx.storage.get<number>('expiresAt'))    ?? 0
      this.trialMode    = (await this.ctx.storage.get<boolean>('trialMode'))   ?? false
      this.fileCounter  = (await this.ctx.storage.get<number>('fileCounter'))  ?? 0
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url  = new URL(request.url)
    const path = url.pathname

    // ? internal endpoint to initialize the DO and set the expiry alarm on first call
    if (path === '/_init') {
      if (this.expiresAt === 0) {
        this.trialMode = url.searchParams.get('trial') === 'true'
        await this.ctx.storage.put('trialMode', this.trialMode)
        const ttl = this.trialMode ? TRIAL_ROOM_TTL_MS : ROOM_TTL_MS
        this.expiresAt = Date.now() + ttl
        await this.ctx.storage.put('expiresAt', this.expiresAt)
        await this.ctx.storage.setAlarm(this.expiresAt)
      }
      return Response.json({ expiresAt: this.expiresAt })
    }

    // ? room expired or doesn't exist guard
    if (this.expiresAt === 0 || (this.expiresAt > 0 && Date.now() > this.expiresAt)) {
      return Response.json(
        { error: 'room_expired' },
        { status: 404, headers: noStoreHeaders() }
      )
    }

    // ? ws upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket()
    }

    // ? routing
    if (path === '/api/note')          return this.handleNote(request)
    if (path === '/api/upload')        return this.handleUpload(request)
    if (path === '/api/files' && request.method === 'GET') return this.handleFileList()
    if (path.startsWith('/api/files/')) return this.handleFileDownload(url)

    return new Response('Not found', { status: 404 })
  }

  private handleWebSocket(): Response {
    const pair   = new WebSocketPair()
    const [client, server] = Object.values(pair)

    this.ctx.acceptWebSocket(server)

    // ? send current room state immediately on connect
    server.send(JSON.stringify({
      type:      'room:sync',
      content:   this.noteContent,
      files:     this.getFileMetas(),
      expiresAt: this.expiresAt,
      trialMode: this.trialMode,
    }))

    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    let msg: Record<string, unknown>
    try { msg = JSON.parse(message) } catch { return }

    const type = msg['type'] as string

    if (type === 'clipboard:share') {
      const text = String(msg['text'] ?? '')
      if (text.length > 1 << 20) return
      this.broadcast({ type: 'clipboard:share', text }, ws)
      return
    }

    if (type === 'note:patch') {
      const content = String(msg['content'] ?? '')
      this.noteContent = content
      // ? persist async, do not await so broadcast is not blocked
      void this.ctx.storage.put('noteContent', content)
      this.broadcast({ type: 'note:patch', edits: msg['edits'], content }, ws)
      return
    }

    if (type === 'note:sync') {
      const content = String(msg['content'] ?? '')
      this.noteContent = content
      void this.ctx.storage.put('noteContent', content)
      this.broadcast({ type: 'note:sync', content }, ws)
      return
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try { ws.close() } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try { ws.close() } catch { /* already closed */ }
  }

  // ? alarm which fires when the room expires. clears storage and disconnects clients. 
  // * the DO instance will eventually be garbage collected by the runtime.
  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM files')
    await this.ctx.storage.deleteAll()
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(1001, 'Room expired') } catch { /* ignore */ }
    }
  }

  // ? handle note GET/POST to fetch/update the current note content. broadcasts updates to WS clients.
  private async handleNote(request: Request): Promise<Response> {
    if (request.method === 'GET') {
      return Response.json(
        { content: this.noteContent },
        { headers: noStoreHeaders() }
      )
    }
    if (request.method === 'POST') {
      let body: { content?: unknown }
      try { body = await request.json() as { content?: unknown } }
      catch { return new Response('Invalid JSON', { status: 400, headers: noStoreHeaders() }) }
      const content = String(body.content ?? '')
      this.noteContent = content
      await this.ctx.storage.put('noteContent', content)
      return new Response('OK', { status: 200, headers: noStoreHeaders() })
    }
    return new Response('Method not allowed', { status: 405, headers: noStoreHeaders() })
  }

  // ? handle file uploads via POSTed form data.
  private async handleUpload(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: noStoreHeaders() })
    }

    if (this.trialMode) {
      return new Response('File uploads are not available in demo mode. Self-host/Docker for full access', {
        status: 403, headers: noStoreHeaders()
      })
    }

    // ? simple rate limiting per IP
    const ip = request.headers.get('CF-Connecting-IP')
      ?? request.headers.get('X-Forwarded-For')?.split(',')[0].trim()
      ?? 'unknown'
    if (!this.checkUploadRate(ip)) {
      return new Response('Too many uploads. Try again in a minute', {
        status: 429, headers: noStoreHeaders()
      })
    }

    if (this.uploadCount >= MAX_ROOM_UPLOADS) {
      return new Response('Room upload limit reached', {
        status: 429, headers: noStoreHeaders()
      })
    }

    let formData: FormData
    try { formData = await request.formData() }
    catch { return new Response('Failed to parse form', { status: 400, headers: noStoreHeaders() }) }

    const fileEntry = formData.get('file')
    if (!fileEntry || typeof fileEntry === 'string') {
      return new Response('No file in request', { status: 400, headers: noStoreHeaders() })
    }
    // ? fileEntry is a File/Blob, cast to access size and arrayBuffer()
    const uploadedFile = fileEntry as unknown as { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }
    if (uploadedFile.size > MAX_FILE_SIZE) {
      return new Response('File exceeds 50 MB limit', { status: 413, headers: noStoreHeaders() })
    }
    if (this.getFileCount() >= MAX_ROOM_FILES) {
      return new Response('Room file limit reached', { status: 413, headers: noStoreHeaders() })
    }
    if (this.getTotalBytes() + uploadedFile.size > MAX_ROOM_STORAGE) {
      return new Response('Room storage limit (250 MB) reached', { status: 413, headers: noStoreHeaders() })
    }

    const data = await uploadedFile.arrayBuffer()
    if (data.byteLength > MAX_FILE_SIZE) {
      return new Response('File exceeds 50 MB limit', { status: 413, headers: noStoreHeaders() })
    }

    // ? Sanitise filename and prefix with timestamp (mirrors Go server)
    const ext = (uploadedFile.name.includes('.') ? '.' + uploadedFile.name.split('.').pop() : '.bin') as string
    this.fileCounter++
    await this.ctx.storage.put('fileCounter', this.fileCounter)
    const filename = `file-${this.fileCounter}${ext}`
    const roomId   = new URL(request.url).searchParams.get('room') ?? 'unknown'
    const url      = `/api/files/${roomId}/${filename}`
    const deleteAt = Date.now() + FILE_TTL_MS

    const meta: UploadedFile = { filename, url, sizeBytes: data.byteLength, deleteAt }

    this.broadcast({ type: 'file:added', file: meta })

    // ?  Persist blob to DO SQL, synchronously.
    this.ctx.storage.sql.exec(
      `INSERT INTO files (filename, url, size_bytes, delete_at, data) VALUES (?, ?, ?, ?, ?)`,
      filename, url, data.byteLength, deleteAt, data
    )

    this.uploadCount++
    return Response.json(meta, { headers: noStoreHeaders() })
  }

  private handleFileList(): Response {
    return Response.json(this.getFileMetas(), { headers: noStoreHeaders() })
  }

  // ? handle file download requests, streaming the blob from DO SQL. 
  // * path is /api/files/:roomId/:filename.
  private handleFileDownload(url: URL): Response {
    const filename = decodeURIComponent(
      url.pathname.replace(/^\/api\/files\/[^/]+\//, '')
    )
    if (!filename) return new Response('Invalid path', { status: 400 })

    const rows = this.ctx.storage.sql.exec(
      `SELECT data FROM files WHERE filename = ? AND delete_at > ?`, filename, Date.now()
    ).toArray()
    if (rows.length === 0) return new Response('File not found or expired', { status: 404 })

    const ext = filename.split('.').pop()?.toLowerCase() ?? ''
    const MIME: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      gif: 'image/gif',  webp: 'image/webp', svg: 'image/svg+xml',
      pdf: 'application/pdf', txt: 'text/plain', md: 'text/plain',
      json: 'application/json', zip: 'application/zip', gz: 'application/gzip',
    }
    const contentType = MIME[ext] ?? 'application/octet-stream'

    return new Response(rows[0]['data'] as ArrayBuffer, {
      headers: {
        'Content-Type':        contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control':       'no-store',
      },
    })
  }

  // ? helper to broadcast a message to all connected WS clients, optionally excluding the sender.
  private broadcast(msg: object, except?: WebSocket): void {
    const data = JSON.stringify(msg)
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue
      try { ws.send(data) } catch { /* stale socket ignore */ }
    }
  }

  private getFileMetas(): UploadedFile[] {
    return this.ctx.storage.sql.exec(
      `SELECT filename, url, size_bytes, delete_at FROM files WHERE delete_at > ? ORDER BY rowid DESC`, Date.now()
    ).toArray().map((row) => ({
      filename:  row['filename']   as string,
      url:       row['url']        as string,
      sizeBytes: row['size_bytes'] as number,
      deleteAt:  row['delete_at']  as number,
    }))
  }

  private getTotalBytes(): number {
    const rows = this.ctx.storage.sql.exec(
      `SELECT COALESCE(SUM(size_bytes), 0) AS total FROM files`
    ).toArray()
    return (rows[0]?.['total'] as number) ?? 0
  }

  private getFileCount(): number {
    const rows = this.ctx.storage.sql.exec(
      `SELECT COUNT(*) AS cnt FROM files`
    ).toArray()
    return (rows[0]?.['cnt'] as number) ?? 0
  }

  // ? simple in-memory rate limiter keyed by IP address. allows UPLOAD_RATE_MAX uploads per IP per rolling minute.
  private checkUploadRate(ip: string): boolean {
    const now    = Date.now()
    const cutoff = now - 60_000
    const times  = (this.uploadCounts.get(ip) ?? []).filter(t => t > cutoff)
    if (times.length >= UPLOAD_RATE_MAX) {
      this.uploadCounts.set(ip, times)
      return false
    }
    times.push(now)
    this.uploadCounts.set(ip, times)
    return true
  }
}
