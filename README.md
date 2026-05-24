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
    image: compactly8274/qbit-cleanup:latest
    ports:
      - "5000:5000"
    environment:
      - QBIT_HOST=http://192.168.1.x
      - QBIT_PORT=8080
      - QBIT_USERNAME=admin
      - QBIT_PASSWORD=adminadmin
      - DOWNLOADS_DIR=/downloads
      - TRASH_DIR=/downloads/.qbit-trash
    volumes:
      - /your/downloads:/downloads
```

```bash
docker compose up -d
# open http://localhost:5000
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `QBIT_HOST` | `http://localhost` | qBittorrent WebUI host |
| `QBIT_PORT` | `8080` | qBittorrent WebUI port |
| `QBIT_USERNAME` | `admin` | WebUI username |
| `QBIT_PASSWORD` | `adminadmin` | WebUI password |
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
docker run -p 5000:5000 \
  -e QBIT_HOST=http://192.168.1.x \
  -v /your/downloads:/downloads \
  qbit-cleanup
```
