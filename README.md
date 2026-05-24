# qBit Cleanup

A Dockerized web application for managing your qBittorrent downloads directory — identifies orphaned files (not tracked by any active torrent) and lets you safely move, review, restore, or permanently delete them.

## Features

- **Orphan detection** — scans your downloads folder and cross-references against active qBittorrent torrents
- **Safe trash system** — moves orphans to a review folder (`.qbit-trash`) with `.meta.json` sidecars preserving original paths
- **Restore** — one-click restore to exact original location
- **Permanent delete** — individual items or bulk clear
- **Dark theme, mobile-first UI**
- **Live connection status** for qBittorrent

## Quick Start

```yaml
# docker-compose.yml
services:
  qbit-cleanup:
    image: ghcr.io/compactly8274/qbit-cleanup:latest
    network_mode: host
    environment:
      - QBIT_HOST=http://localhost
      - QBIT_PORT=8080
      - QBIT_API_KEY=your_api_key_here
      - DOWNLOADS_DIR=/downloads
      - TRASH_DIR=/downloads/.qbit-trash
    volumes:
      - /your/downloads:/downloads
    restart: unless-stopped
```

```bash
docker compose up -d
# open http://<your-server-ip>:5000
```

## Authentication

### API Key (qBittorrent 5.0+, recommended)

1. In qBittorrent go to **Tools → Options → Web UI → API Key**
2. Generate a key and copy it
3. Set `QBIT_API_KEY` in your compose file

### Username / Password (qBittorrent < 5.0, fallback)

If you're running an older version that doesn't support API keys, use `QBIT_USERNAME` and `QBIT_PASSWORD` instead and omit `QBIT_API_KEY`.

```yaml
    environment:
      - QBIT_API_KEY=        # leave blank or remove to use password auth
      - QBIT_USERNAME=admin
      - QBIT_PASSWORD=adminadmin
```

## Networking

The container runs with `network_mode: host`, meaning it shares the host's network stack rather than getting its own Docker bridge IP.

**Why this matters:** qBittorrent's WebUI has an IP whitelist (Tools → Options → Web UI → allowed IPs). When a container runs on the default Docker bridge its requests come from a `172.x.x.x` address which is typically not whitelisted. With `network_mode: host` the container makes requests from the host's LAN IP, which is already covered by your whitelist.

This also means:
- `QBIT_HOST=http://localhost` works directly
- No `ports:` mapping is needed — the app binds to port `5000` on the host directly
- **Linux only** — `network_mode: host` has no effect on Docker Desktop for Mac/Windows (see below)

### Mac / Windows (Docker Desktop)

Remove `network_mode: host` and add:

```yaml
    environment:
      - QBIT_HOST=http://host.docker.internal
    ports:
      - "5000:5000"
```

You will also need to add the Docker bridge subnet (typically `172.17.0.0/16`) to qBittorrent's WebUI allowed IPs list.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `QBIT_HOST` | `http://localhost` | qBittorrent WebUI host |
| `QBIT_PORT` | `8080` | qBittorrent WebUI port |
| `QBIT_API_KEY` | *(empty)* | API key — preferred auth for qBittorrent 5.0+ |
| `QBIT_USERNAME` | *(empty)* | Username — fallback for qBittorrent < 5.0 |
| `QBIT_PASSWORD` | *(empty)* | Password — fallback for qBittorrent < 5.0 |
| `DOWNLOADS_DIR` | `/downloads` | Path to your downloads directory |
| `TRASH_DIR` | `/downloads/.qbit-trash` | Where orphans are moved for review |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/status` | qBit connection status + item counts |
| GET | `/api/orphans` | List orphaned files/folders |
| POST | `/api/orphans/move` | Move one (`{"path":"..."}`) or all (empty body) to trash |
| GET | `/api/trash` | List trash items |
| POST | `/api/trash/restore` | Restore one or all items |
| POST | `/api/trash/delete` | Permanently delete one or all items |

## Building locally

```bash
docker build -t qbit-cleanup .
docker run --network host \
  -e QBIT_API_KEY=your_api_key_here \
  -v /your/downloads:/downloads \
  qbit-cleanup
```
