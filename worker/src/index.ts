import { Room, generateRoomId } from './room'

// ? re-export so Wrangler can find the DO class
export { Room }

export interface Env {
  ROOM:        DurableObjectNamespace<Room>
  ASSETS:      Fetcher
  OWNER_TOKEN: string
}

const CORS: HeadersInit = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

const AUTH_COOKIE  = 'synclippy_auth'
const COOKIE_MAX_AGE = 90 * 24 * 60 * 60  // * 90 days, rolling

// ? helper to add CORS headers to API responses. Not needed for the WebSocket endpoint.
function withCors(res: Response): Response {
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v)
  return new Response(res.body, {
    status:     res.status,
    statusText: res.statusText,
    headers,
  })
}

async function computeAuthCookie(token: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('synclippy-v1'))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

async function isOwner(request: Request, env: Env): Promise<boolean> {
  if (!env.OWNER_TOKEN) return false
  const cookies = request.headers.get('Cookie') ?? ''
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=([^;]+)`))
  if (!match) return false
  const expected = await computeAuthCookie(env.OWNER_TOKEN)
  return match[1] === expected
}

function setAuthCookie(value: string): string {
  return `${AUTH_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}`
}

function clearAuthCookie(): string {
  return `${AUTH_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`
}

// ? rolling expiry, reattach the cookie on any authenticated page load
function withRollingCookie(res: Response, cookieValue: string): Response {
  const headers = new Headers(res.headers)
  headers.set('Set-Cookie', setAuthCookie(cookieValue))
  return new Response(res.body, {
    status:     res.status,
    statusText: res.statusText,
    headers,
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url  = new URL(request.url)
    const path = url.pathname

    // ? cors preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }

    // ? GET /healthz is used by monitors and must return CORS-enabled JSON.
    if (path === '/healthz' && request.method === 'GET') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    // ? GET /auth?t=<token> serves auto-POST page
    if (path === '/auth' && request.method === 'GET') {
      const token = url.searchParams.get('t') ?? ''
      return new Response(
        `<!DOCTYPE html><html><body><script>` +
        `fetch('/auth-submit',{method:'POST',headers:{'Content-Type':'application/json'},` +
        `body:JSON.stringify({token:${JSON.stringify(token)}})})` +
        `.then(r=>{if(r.ok)location.href='/';else document.body.textContent='Invalid token'})` +
        `.catch(()=>document.body.textContent='Network error')` +
        `</script>Authenticating…</body></html>`,
        { status: 200, headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' } }
      )
    }

    // ? POST /auth-submit validates token and sets cookie
    if (path === '/auth-submit' && request.method === 'POST') {
      if (!env.OWNER_TOKEN) {
        return Response.json({ ok: false, error: 'auth_not_configured' }, { status: 500 })
      }
      let body: { token?: string }
      try { body = await request.json() as { token?: string } }
      catch { return Response.json({ ok: false }, { status: 400 }) }

      const token = body.token ?? ''

      // ? constant-time compare via HMAC
      const expected = await computeAuthCookie(env.OWNER_TOKEN)
      const provided = await computeAuthCookie(token)
      if (expected !== provided) {
        return Response.json({ ok: false }, { status: 401 })
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'Content-Type':  'application/json',
          'Set-Cookie':    setAuthCookie(expected),
          'Cache-Control': 'no-store',
        },
      })
    }

    // ? POST /auth/logout clears cookie
    if (path === '/auth/logout' && request.method === 'POST') {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'Content-Type':  'application/json',
          'Set-Cookie':    clearAuthCookie(),
          'Cache-Control': 'no-store',
        },
      })
    }

    // ? create new room, trial mode unless authenticated
    if (path === '/api/room/new' && request.method === 'GET') {
      const owner  = await isOwner(request, env)
      const trial  = !owner
      const roomId = generateRoomId()
      const stub   = env.ROOM.get(env.ROOM.idFromName(roomId))
      const initRes  = await stub.fetch(new Request(`${url.origin}/_init?trial=${trial}`))
      const { expiresAt } = await initRes.json() as { expiresAt: number }
      const res = Response.json(
        { roomId, expiresAt },
        { headers: { ...CORS, 'Cache-Control': 'no-store' } }
      )
      // ? rolling cookie refresh on room creation
      if (owner) {
        const cookieVal = await computeAuthCookie(env.OWNER_TOKEN)
        return withRollingCookie(res, cookieVal)
      }
      return res
    }

    // ? route to Durable Object
    const roomParam    = url.searchParams.get('room')
    const filePathRoom = path.match(/^\/api\/files\/([a-z]+-[a-z]+-[a-z]+)\//)?.[1]
    const targetRoom   = roomParam ?? filePathRoom

    if (targetRoom) {
      const stub = env.ROOM.get(env.ROOM.idFromName(targetRoom))
      const res  = await stub.fetch(request)
      if (res.status === 101) return res
      return withCors(res)
    }

    // ? rolling cookie refresh on page loads
    const owner = await isOwner(request, env)
    let res = await env.ASSETS.fetch(request)

    // ? SPA routing fallback: if asset not found and request accepts HTML or has no extension
    if (res.status === 404 && request.method === 'GET') {
      const accept = request.headers.get('Accept') || ''
      if (accept.includes('text/html') || !path.includes('.')) {
        res = await env.ASSETS.fetch(new Request(new URL('/', request.url), request))
      }
    }

    if (owner) {
      const cookieVal = await computeAuthCookie(env.OWNER_TOKEN)
      return withRollingCookie(res, cookieVal)
    }
    return res
  },
}
