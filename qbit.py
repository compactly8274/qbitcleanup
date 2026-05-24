import qbittorrentapi
import config

_client = None


def _get_client():
    global _client
    if _client is None:
        _client = qbittorrentapi.Client(
            host=config.QBIT_HOST,
            port=config.QBIT_PORT,
            username=config.QBIT_USERNAME,
            password=config.QBIT_PASSWORD,
            REQUESTS_ARGS={"timeout": 10},
            VERIFY_WEBUI_CERTIFICATE=False,
        )
    return _client


def get_status():
    client = _get_client()
    try:
        client.auth_log_in()
        version = client.app.version
        return {"connected": True, "version": version}
    except qbittorrentapi.LoginFailed:
        return {"connected": False, "version": None, "error": "Login failed — check credentials"}
    except qbittorrentapi.APIConnectionError:
        return {"connected": False, "version": None}
    except Exception:
        return {"connected": False, "version": None}


def get_torrent_paths():
    """Return a set of absolute paths claimed by active torrents, or None on error."""
    client = _get_client()
    try:
        client.auth_log_in()
        torrents = client.torrents_info()
    except qbittorrentapi.LoginFailed:
        return None
    except qbittorrentapi.APIConnectionError:
        return None
    except Exception:
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
                # Protect all intermediate directories
                parts = f.name.split("/")
                for i in range(1, len(parts)):
                    paths.add(f"{save_path}/{'/'.join(parts[:i])}")
        except Exception:
            pass

    return paths
