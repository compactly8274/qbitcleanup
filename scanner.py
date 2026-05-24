from pathlib import Path
import config


def _get_size(path):
    p = Path(path)
    if p.is_symlink():
        return p.lstat().st_size
    if p.is_file():
        return p.stat().st_size
    total = 0
    try:
        for child in p.rglob("*"):
            if not child.is_symlink() and child.is_file():
                try:
                    total += child.stat().st_size
                except OSError:
                    pass
    except PermissionError:
        pass
    return total


def _format_size(size_bytes):
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f} PB"


def _entry_info(path, downloads_root):
    p = Path(path)
    try:
        rel = str(p.relative_to(downloads_root))
    except ValueError:
        rel = p.name
    try:
        st = p.lstat()
        size = _get_size(path)
        return {
            "path": str(p),
            "name": p.name,
            "relative_path": rel,
            "size": size,
            "size_human": _format_size(size),
            "modified": int(st.st_mtime),
            "is_dir": p.is_dir() and not p.is_symlink(),
        }
    except OSError as e:
        return {
            "path": str(p),
            "name": p.name,
            "relative_path": rel,
            "size": 0,
            "size_human": "0 B",
            "modified": 0,
            "is_dir": False,
            "error": str(e),
        }


def _is_protected(entry, protected_paths):
    """True if the entry itself is a protected path."""
    candidates = {str(entry)}
    if not entry.is_symlink():
        try:
            candidates.add(str(entry.resolve()))
        except OSError:
            pass
    candidates.add(str(entry.absolute()))
    return bool(candidates & protected_paths)


def _has_protected_descendant(directory, protected_paths):
    """True if any path inside directory is protected."""
    prefix = str(directory).rstrip("/") + "/"
    return any(p.startswith(prefix) for p in protected_paths)


def _scan_dir(directory, protected_paths, trash, downloads_root, results):
    try:
        entries = sorted(directory.iterdir(), key=lambda e: e.name.lower())
    except PermissionError:
        return

    for entry in entries:
        # Skip hidden files and the trash folder
        if entry.name.startswith("."):
            continue
        try:
            if entry.resolve() == trash:
                continue
        except OSError:
            pass

        if _is_protected(entry, protected_paths):
            # Owned by an active torrent — skip entirely
            continue

        if entry.is_dir() and not entry.is_symlink():
            if _has_protected_descendant(entry, protected_paths):
                # Mix of owned and unowned content inside — recurse
                _scan_dir(entry, protected_paths, trash, downloads_root, results)
            else:
                # Nothing inside is protected — whole folder is orphaned
                results.append(_entry_info(str(entry), downloads_root))
        else:
            results.append(_entry_info(str(entry), downloads_root))


def scan_orphans(protected_paths):
    """
    Recursively scan DOWNLOADS_DIR and return entries not claimed by any active torrent.
    Drills into container folders (e.g. 'movies/', 'complete/') to find orphans within them.
    """
    downloads = Path(config.DOWNLOADS_DIR)
    trash = Path(config.TRASH_DIR).resolve()

    if not downloads.exists():
        return {"error": f"Downloads directory not found: {config.DOWNLOADS_DIR}"}

    orphans = []
    try:
        _scan_dir(downloads, protected_paths, trash, downloads, orphans)
    except Exception as e:
        return {"error": str(e)}

    return orphans
