import os
import stat
from pathlib import Path
import config


def _get_size(path):
    """Recursively compute size of a file or directory."""
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


def _entry_info(path):
    p = Path(path)
    try:
        st = p.lstat()
        size = _get_size(path)
        return {
            "path": str(p),
            "name": p.name,
            "size": size,
            "size_human": _format_size(size),
            "modified": int(st.st_mtime),
            "is_dir": p.is_dir() and not p.is_symlink(),
        }
    except OSError as e:
        return {
            "path": str(p),
            "name": p.name,
            "size": 0,
            "size_human": "0 B",
            "modified": 0,
            "is_dir": False,
            "error": str(e),
        }


def scan_orphans(protected_paths):
    """
    Scan DOWNLOADS_DIR top-level entries and return those not in protected_paths.
    protected_paths is a set of absolute path strings.
    """
    downloads = Path(config.DOWNLOADS_DIR)
    trash = Path(config.TRASH_DIR).resolve()

    if not downloads.exists():
        return {"error": f"Downloads directory not found: {config.DOWNLOADS_DIR}"}

    orphans = []
    try:
        entries = list(downloads.iterdir())
    except PermissionError as e:
        return {"error": str(e)}

    for entry in sorted(entries, key=lambda e: e.name.lower()):
        # Skip the trash directory itself
        try:
            if entry.resolve() == trash:
                continue
        except OSError:
            pass
        if entry.name.startswith("."):
            continue

        abs_path = str(entry.resolve()) if not entry.is_symlink() else str(entry)
        norm_path = str(entry)

        # Check if this entry or any parent is protected
        is_protected = (
            abs_path in protected_paths
            or norm_path in protected_paths
            or str(entry.absolute()) in protected_paths
        )

        if not is_protected:
            orphans.append(_entry_info(str(entry)))

    return orphans
