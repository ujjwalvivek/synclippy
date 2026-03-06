# synclippy

A tiny ephemeral clipboard and file transfer tool I built for myself.

Drop text, share files, push your clipboard, all through a ephemeral 5-minute room. No account needed.

## What it does

- Opens a room with a shareable 3-word URL: `/oak-river-gentle`
- Real-time text sync across all connected browsers via WebSocket
- Paste or drag files up to 50 MB, they live in the room until it expires
- Clipboard sharing with explicit allow/deny (no silent clipboard access)
- Room self-destructs after 5 minutes
- Docker or Self host with a single binary (Linux, macOS, Windows)
- Try it out: [synclippy.ujjwalvivek.com](https://synclippy.ujjwalvivek.com)

## Use it

**Hosted on Cloudflare:** [synclippy.ujjwalvivek.com](https://synclippy.ujjwalvivek.com)

> The expected deployment is behind a reverse proxy (nginx, Caddy, Cloudflare Tunnel) that handles TLS. TLS-terminating proxy is expected. The Go binary listens on HTTP. If you want TLS in the binary, use the Cloudflare Worker deployment or set up your own certs with autocert.

**Self-host with Docker:**

```sh
docker run -d -p 8080:8080 ghcr.io/ujjwalvivek/synclippy
# or
docker run -d -p 8080:8080 ujjwalvivek/synclippy
```

Open [http://localhost:8080](http://localhost:8080).

**Binary:** grab the right build from [Releases](https://github.com/ujjwalvivek/synclippy/releases):

```sh
chmod +x synclippy-linux-amd64
./synclippy-linux-amd64
# Custom port:
PORT=9090 ./synclippy-linux-amd64
```

**docker-compose:**

```yaml
services:
  synclippy:
    image: ghcr.io/ujjwalvivek/synclippy
    ports:
      - "8080:8080"
    environment:
      PORT: 8080
    restart: unless-stopped
```

## Building from source

Requires: Go ≥ 1.23, Node.js ≥ 20

```sh
git clone https://github.com/ujjwalvivek/synclippy
cd synclippy
./build.sh
```

## GitHub secrets

For the workflows to function you need these set in the repo settings:

| Secret            | Used by             | Description                                      |
| ----------------- | ------------------- | ------------------------------------------------ |
| `DOCKER_USERNAME` | `release.yml`       | Docker Hub username                              |
| `DOCKER_PASSWORD` | `release.yml`       | Docker Hub token                                 |
| `CF_API_TOKEN`    | `deploy-worker.yml` | Cloudflare API token (Workers deploy permission) |
| `CF_ACCOUNT_ID`   | `deploy-worker.yml` | Cloudflare account ID                            |
| `VITE_API_BASE`   | `deploy-worker.yml` | Leave empty. Worker serves its own API           |

## License

MIT
