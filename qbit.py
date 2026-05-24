import requests
import config

_session = None


def _get_session():
    global _session
    if _session is None:
        _session = requests.Session()
    return _session


def login():
    s = _get_session()
    try:
        resp = s.post(
            f"{config.QBIT_URL}/api/v2/auth/login",
            data={"username": config.QBIT_USERNAME, "password": config.QBIT_PASSWORD},
            timeout=5,
        )
        return resp.text == "Ok."
    except requests.RequestException:
        return False


def get_status():
    s = _get_session()
    try:
        resp = s.get(f"{config.QBIT_URL}/api/v2/app/version", timeout=5)
        if resp.status_code == 403:
            if login():
                resp = s.get(f"{config.QBIT_URL}/api/v2/app/version", timeout=5)
        if resp.status_code == 200:
            return {"connected": True, "version": resp.text}
    except requests.RequestException:
        pass
    return {"connected": False, "version": None}


def get_torrent_paths():
    """Return a set of absolute paths claimed by active torrents."""
    s = _get_session()
    try:
        resp = s.get(f"{config.QBIT_URL}/api/v2/torrents/info", timeout=10)
        if resp.status_code == 403:
            if login():
                resp = s.get(f"{config.QBIT_URL}/api/v2/torrents/info", timeout=10)
        if resp.status_code != 200:
            return None
        torrents = resp.json()
    except requests.RequestException:
        return None

    paths = set()
    for t in torrents:
        save_path = t.get("save_path", "").rstrip("/")
        name = t.get("name", "")
        content_path = t.get("content_path", "")

        # Add the torrent's root content path
        if content_path:
            paths.add(content_path.rstrip("/"))

        # Add individual file paths for multi-file torrents
        files_resp = None
        try:
            files_resp = s.get(
                f"{config.QBIT_URL}/api/v2/torrents/files",
                params={"hash": t["hash"]},
                timeout=10,
            )
        except requests.RequestException:
            pass

        if files_resp and files_resp.status_code == 200:
            for f in files_resp.json():
                full_path = f"{save_path}/{f['name']}"
                paths.add(full_path)
                # Also protect all parent directories up to save_path
                parts = f["name"].split("/")
                for i in range(1, len(parts)):
                    paths.add(f"{save_path}/{'/'.join(parts[:i])}")

        # Always protect the save_path/name directory
        if name and save_path:
            paths.add(f"{save_path}/{name}")

    return paths
