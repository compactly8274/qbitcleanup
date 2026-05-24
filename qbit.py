import logging
import qbittorrentapi
import config

log = logging.getLogger(__name__)

_client = None


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
