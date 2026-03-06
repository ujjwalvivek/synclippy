# Server API Reference

Base URL depends on deployment:

- Self-hosted: `http://localhost:8080`
- Online: `https://synclippy.ujjwalvivek.com`

All API responses include `Cache-Control: no-store`. CORS is wide open (`*`).

## REST Endpoints

### `GET /healthz`

**Response** `200`

```json
{ "status": "ok" }
```

### `GET /api/room/new`

**Response** `200`

```json
{
  "roomId": "oak-river-gentle",
  "expiresAt": 1709740800000
}
```

### `GET /api/note?room={roomId}`

**Response** `200`

```json
{ "content": "hello world" }
```

**Error** `404`

```json
{ "error": "room_expired" }
```

### `POST /api/note?room={roomId}`

Save note content. Body is capped at 52 MB.

**Request** .

```json
{ "content": "updated text" }
```

**Response** `200` -> `OK`

### `POST /api/upload?room={roomId}`

**Limits enforced server-side:**

**Response** `200`

```json
{
  "filename": "oak-river-gentle-file-1.png",
  "url": "/api/files/oak-river-gentle/oak-river-gentle-file-1.png",
  "sizeBytes": 204800,
  "deleteAt": 1709740860000
}
```

**Errors:**

- `413` file too large, room storage full, or file limit reached
- `429` rate limited (IP) or room upload limit reached (20 per room lifetime)
- `404` room expired
  
### `GET /api/files?room={roomId}`

**Response** `200`

```json
[
  {
    "filename": "oak-river-gentle-file-1.png",
    "url": "/api/files/oak-river-gentle/oak-river-gentle-file-1.png",
    "sizeBytes": 204800,
    "deleteAt": 1709740860000
  }
]
```

### `GET /api/files/{roomId}/{filename}`

Download a file. Returns the raw bytes with appropriate `Content-Type` and
`Content-Disposition: attachment` headers.

**Errors:**

- `404` -> room expired or file not found

### Summary

| Method | Route                          | Description                              |
| ------ | ------------------------------ | ---------------------------------------- |
| `GET`  | `/healthz`                     | Liveness probe → `{ status: "ok" }`      |
| `GET`  | `/api/room/new`                | Create room → `{ roomId, expiresAt }`    |
| `GET`  | `/api/note?room=ID`            | Get note → `{ content }`                 |
| `POST` | `/api/note?room=ID`            | Save note `{ content }`                  |
| `POST` | `/api/upload?room=ID`          | Upload file (multipart) → `UploadedFile` |
| `GET`  | `/api/files?room=ID`           | List files → `UploadedFile[]`            |
| `GET`  | `/api/files/:roomId/:filename` | Download file                            |
| `WS`   | `/ws?room=ID`                  | Real-time sync                           |

## WebSocket Protocol

### Connect

```bash
ws://localhost:8080/ws?room={roomId}
```

### Server → Client

| `type`            | Payload                           | When                            |
| ----------------- | --------------------------------- | ------------------------------- |
| `room:sync`       | `{ content, files[], expiresAt }` | Immediately on connect          |
| `note:patch`      | `{ edits[], content }`            | Another client edited           |
| `note:sync`       | `{ content }`                     | Full content replace            |
| `clipboard:share` | `{ text }`                        | Another client shared clipboard |
| `file:added`      | `{ file: UploadedFile }`          | File uploaded to room           |

### Client → Server

| `type`            | Payload                | Notes                                              |
| ----------------- | ---------------------- | -------------------------------------------------- |
| `note:patch`      | `{ edits[], content }` | Incremental edit + full content for reconciliation |
| `note:sync`       | `{ content }`          | Full replace (rare)                                |
| `clipboard:share` | `{ text }`             | Capped at 1 MB. Exceeding silently dropped.        |

### Edit Operation Shape

```typescript
interface EditOp {
  range: {
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  }
  text: string
}
```

### UploadedFile Shape

```typescript
interface UploadedFile {
  filename: string   // server-generated safe name
  url: string        // relative path for download
  sizeBytes: number
  deleteAt: number   // Unix ms -> file auto-expires with the room
}
```

## Limits Summary

| Resource            | Limit     |
| ------------------- | --------- |
| Room TTL            | 5 minutes |
| File size           | 50 MB     |
| Files per room      | 5         |
| Uploads per room    | 20        |
| Room storage        | 250 MB    |
| Uploads / IP / min  | 3         |
| Note body (POST)    | 52 MB     |
| WebSocket message   | 52 MB     |
| Clipboard broadcast | 1 MB      |

## Trial Mode

The online demo at `synclippy.ujjwalvivek.com` has a few extra limits to prevent abuse:

- Room TTL is 2 minutes instead of 5
- Uploads per IP per minute is 1 instead of 3
- File size is capped at 10 MB instead of 50 MB
- Total room storage is capped at 100 MB instead of 250 MB
- WebSocket messages are capped at 10 MB instead of 52 MB
- Clipboard broadcasts are capped at 100 KB instead of 1 MB
- No more than 2 active rooms per IP at a time
