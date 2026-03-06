import { writable } from 'svelte/store'

// localStorage key used for ephemeral note caching when offline
const KEY = 'synclippy_note'

// External backend URL -> empty means same-origin (self-hosted binary/Docker).
// Set VITE_API_BASE at build time for Cloudflare Pages deployments.
const BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '')

// internal handler signatures used by WSClient
type MessageHandler = (msg: WSMessage) => void
type StatusHandler = (ready: boolean) => void

// These interfaces are used throughout the frontend/backend to keep the
// protocol lean and JSON‑friendly.
export interface UploadedFile {
  filename: string
  url: string
  sizeBytes: number
  deleteAt: number
}

export interface EditRange {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

export interface EditOp {
  range: EditRange
  text: string
}

// Shapes sent over the WS connection.  The server sends the first four
// message types; the client only ever transmits patch/sync/clipboard events.
export type WSMessage =
  | { type: 'room:sync';       content: string; files: UploadedFile[]; expiresAt: number; trialMode?: boolean }
  | { type: 'note:patch';      edits: EditOp[];  content: string }
  | { type: 'note:sync';       content: string }
  | { type: 'clipboard:share'; text: string }
  | { type: 'file:added';      file: UploadedFile }

// thin wrappers around REST endpoints used by the UI; they throw on
// network failures or propagate backend error messages exactly as they are.
export async function apiCreateRoom(): Promise<{ roomId: string; expiresAt: number }> {
  const res = await fetch(`${BASE}/api/room/new`, { credentials: 'include' })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Failed to create room (${res.status}${body ? ': ' + body.slice(0, 120) : ''})`)
  }
  return res.json()
}

export async function apiLoadNote(roomId: string): Promise<string> {
  const res = await fetch(`${BASE}/api/note?room=${encodeURIComponent(roomId)}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    if (body?.error === 'room_expired') throw Object.assign(new Error('room_expired'), { code: 'room_expired' })
    throw new Error('Failed to load note')
  }
  const data = await res.json()
  return data.content ?? ''
}

export async function apiUploadFile(roomId: string, file: File): Promise<UploadedFile> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${BASE}/api/upload?room=${encodeURIComponent(roomId)}`, { method: 'POST', body: form })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || 'Upload failed')
  }
  return res.json()
}

// matches error messages from both Go and Worker backends for upload limit errors
export function isStorageLimitError(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? ''
  return /storage limit|Room storage|file limit|Room file limit|Too many uploads|demo mode/i.test(msg)
}

// the Svelte store used by child components (context menu, toolbar) to
// manipulate the shared editor instance without prop‑drilling.
export interface EditorAPI {
  getValue(): string
  setValue(v: string): void
  setValueForce(v: string): void
  applyRemoteEdits(edits: EditOp[]): void
  focus(): void
  insertText(text: string): void
  appendText(text: string): void
  undo(): void
  redo(): void
  getSelectedText(): string
  selectAll(): void
  scrollToBottom(): void
}

export const editorAPI = writable<EditorAPI | null>(null)

// true when the current room is a demo/trial room (CF hosted, unauthenticated)
export const trialMode = writable<boolean>(false)

// simple wrappers around `localStorage` for auto‑saving notes locally.
export function storageLoad(): string {
  return localStorage.getItem(KEY) ?? ''
}

export function storageSave(content: string) {
  localStorage.setItem(KEY, content)
}

// used by the main application script to synchronize
// edits and clipboard events across users.
class WSClient {
  private ws: WebSocket | null = null
  private handlers: MessageHandler[] = []
  private statusHandlers: StatusHandler[] = []
  private _ready = false
  private reconnectTimer: number | null = null
  private roomId = ''
  private retryCount = 0

  get ready() {
    return this._ready
  }

  connect(roomId: string) {
    this.roomId = roomId
    // Empty BASE → same-origin (self-hosted). Set BASE → convert http(s) to ws(s).
    let wsUrl: string
    if (BASE === '') {
      const proto = location.protocol === 'https:' ? 'wss://' : 'ws://'
      wsUrl = proto + location.host + '/ws?room=' + encodeURIComponent(roomId)
    } else {
      const wsBase = BASE.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://')
      wsUrl = wsBase + '/ws?room=' + encodeURIComponent(roomId)
    }

    this.ws = new WebSocket(wsUrl)

    this.ws.onopen = () => {
      this._ready = true
      this.retryCount = 0
      this.statusHandlers.forEach(h => h(true))
    }

    this.ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data)
        this.handlers.forEach(h => h(msg))
      } catch {
        // ignore malformed messages
      }
    }

    this.ws.onclose = () => {
      this._ready = false
      this.statusHandlers.forEach(h => h(false))
      if (this.roomId) {
        // Exponential backoff with jitter: 1s × 2^attempt, capped at 30s, +random(0–1s)
        const base = Math.min(30000, 1000 * Math.pow(2, this.retryCount))
        const delay = base + Math.random() * 1000
        this.retryCount++
        this.reconnectTimer = window.setTimeout(() => this.connect(this.roomId), delay)
      }
    }

    // on error just force close; onclose handler takes care of reconnecting
    this.ws.onerror = () => {
      this.ws?.close()
    }
  }

  addHandler(handler: MessageHandler) {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  onStatus(handler: StatusHandler) {
    this.statusHandlers.push(handler)
    return () => {
      this.statusHandlers = this.statusHandlers.filter(h => h !== handler)
    }
  }

  send(msg: object) {
    if (this._ready && this.ws) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  destroy() {
    // clean up and prevent further reconnect attempts
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.roomId = ''
    this.ws?.close()
  }
}

export const wsClient = new WSClient()

