import logging
import qbittorrentapi
import config

log = logging.getLogger(__name__)

_client = None

_UNREGISTERED_MSGS = (
    "unregistered torrent",
    "not registered",
    "torrent not found",
    "torrent not registered",
    "infohash not found",
    "could not find torrent",
    "unknown infohash",
    "info_hash not found",
)


def _fmt_size(b):
    for u in ("B", "KB", "MB", "GB", "TB"):
        if b < 1024:
            return f"{b:.1f} {u}"
        b /= 1024
    return f"{b:.1f} PB"


def _get_client():
    global _client
    if _client is None:
        kwargs = dict(
            host=config.QBIT_HOST,
            port=config.QBIT_PORT,
            REQUESTS_ARGS={"timeout": 10},
            VERIFY_WEBUI_CERTIFICATE=False,
        )
        if config.QBIT_API_KEY:
            kwargs["EXTRA_HEADERS"] = {"X-Api-Key": config.QBIT_API_KEY}
        else:
            kwargs["username"] = config.QBIT_USERNAME
            kwargs["password"] = config.QBIT_PASSWORD

        log.info(
            "Connecting to qBittorrent at %s:%s (auth: %s)",
            config.QBIT_HOST,
            config.QBIT_PORT,
            "api_key" if config.QBIT_API_KEY else "username/password",
        )
        _client = qbittorrentapi.Client(**kwargs)
    return _client


def _connect(client):
    if not config.QBIT_API_KEY:
        client.auth_log_in()


def get_status():
    client = _get_client()
    try:
        _connect(client)
        version = client.app.version
        log.debug("qBittorrent connected, version %s", version)
        return {"connected": True, "version": version}
    except qbittorrentapi.LoginFailed as e:
        log.warning("qBittorrent login failed: %s", e)
        return {"connected": False, "version": None, "error": f"Login failed: {e}"}
    except qbittorrentapi.APIConnectionError as e:
        log.warning("qBittorrent connection error: %s", e)
        return {"connected": False, "version": None, "error": f"Connection error: {e}"}
    except Exception as e:
        log.exception("Unexpected error connecting to qBittorrent")
        return {"connected": False, "version": None, "error": str(e)}


def get_torrent_paths():
    """Return a set of absolute paths claimed by active torrents, or None on error."""
    client = _get_client()
    try:
        _connect(client)
        torrents = client.torrents_info()
    except qbittorrentapi.LoginFailed as e:
        log.warning("qBittorrent login failed fetching torrents: %s", e)
        return None
    except qbittorrentapi.APIConnectionError as e:
        log.warning("qBittorrent connection error fetching torrents: %s", e)
        return None
    except Exception as e:
        log.exception("Unexpected error fetching torrent list")
        return None

    paths = set()
    for t in torrents:
        save_path = (t.save_path or "").rstrip("/")
        name = t.name or ""
        content_path = (t.content_path or "").rstrip("/")

        if content_path:
            paths.add(content_path)

        if name and save_path:
            paths.add(f"{save_path}/{name}")

        try:
            files = client.torrents_files(torrent_hash=t.hash)
            for f in files:
                full_path = f"{save_path}/{f.name}"
                paths.add(full_path)
                parts = f.name.split("/")
                for i in range(1, len(parts)):
                    paths.add(f"{save_path}/{'/'.join(parts[:i])}")
        except Exception as e:
            log.debug("Could not fetch files for torrent %s: %s", t.hash, e)

    return paths


def get_unregistered_torrents():
    """Return torrents where any tracker reports an unregistered-type error.
    Makes one extra API call per torrent to check tracker messages."""
    client = _get_client()
    try:
        _connect(client)
        torrents = client.torrents_info()
    except Exception as e:
        log.warning("Failed to fetch torrent list: %s", e)
        return None

    result = []
    for t in torrents:
        try:
            trackers = client.torrents_trackers(torrent_hash=t.hash)
        except Exception:
            continue

        tracker_msg = ""
        for tr in trackers:
            if (tr.url or "") in ("** [DHT] **", "** [PeX] **", "** [LSD] **"):
                continue
            msg = (tr.msg or "").lower()
            if any(p in msg for p in _UNREGISTERED_MSGS):
                tracker_msg = tr.msg or msg
                break

        if not tracker_msg:
            continue

        size = t.size or 0
        result.append({
            "hash": t.hash,
            "name": t.name or "",
            "save_path": (t.save_path or "").rstrip("/"),
            "content_path": (t.content_path or "").rstrip("/"),
            "size": size,
            "size_human": _fmt_size(size),
            "added_on": t.added_on or 0,
            "ratio": round(float(t.ratio or 0), 2),
            "state": t.state or "",
            "tracker": t.tracker or "",
            "tracker_msg": tracker_msg,
        })

    log.info("Unregistered torrent check: %d found out of %d", len(result), len(torrents))
    return result


def remove_torrents(hashes, delete_files=False):
    """Remove torrents from qBittorrent. If delete_files=True, also deletes data files."""
    client = _get_client()
    try:
        _connect(client)
        client.torrents_delete(delete_files=delete_files, torrent_hashes=hashes)
        log.info("Removed %d torrent(s) (delete_files=%s)", len(hashes), delete_files)
        return True
    except Exception as e:
        log.warning("Failed to remove torrents: %s", e)
        return False
