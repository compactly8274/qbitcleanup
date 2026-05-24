import json
import os
import shutil
from pathlib import Path
import config


def _meta_path(trash_entry_path):
    return Path(str(trash_entry_path) + ".meta.json")


def _write_meta(trash_entry_path, original_path):
    meta = {"original_path": str(original_path)}
    _meta_path(trash_entry_path).write_text(json.dumps(meta))


def _read_meta(trash_entry_path):
    mp = _meta_path(trash_entry_path)
    if mp.exists():
        try:
            return json.loads(mp.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def move_to_trash(src_path):
    """Move src_path into TRASH_DIR, preserving relative structure. Returns trash path."""
    src = Path(src_path)
    if not src.exists() and not src.is_symlink():
        raise FileNotFoundError(f"Not found: {src_path}")

    downloads = Path(config.DOWNLOADS_DIR)
    trash = Path(config.TRASH_DIR)
    trash.mkdir(parents=True, exist_ok=True)

    try:
        rel = src.relative_to(downloads)
    except ValueError:
        rel = Path(src.name)

    dest = trash / rel
    dest.parent.mkdir(parents=True, exist_ok=True)

    # Avoid collision
    if dest.exists() or _meta_path(dest).exists():
        base = dest.name
        parent = dest.parent
        i = 1
        while (parent / f"{base}.{i}").exists() or _meta_path(parent / f"{base}.{i}").exists():
            i += 1
        dest = parent / f"{base}.{i}"

    shutil.move(str(src), str(dest))
    _write_meta(dest, src)
    return str(dest)


def list_trash():
    """Return list of items directly inside TRASH_DIR (with metadata)."""
    trash = Path(config.TRASH_DIR)
    if not trash.exists():
        return []

    items = []
    for entry in sorted(trash.iterdir(), key=lambda e: e.name.lower()):
        if entry.name.startswith(".") or entry.suffix == ".json":
            continue
        # Skip .meta.json sidecars
        if entry.name.endswith(".meta.json"):
            continue

        meta = _read_meta(entry)
        original_path = meta.get("original_path", "")

        size = _dir_size(entry) if entry.is_dir() else _file_size(entry)
        try:
            st = entry.stat()
            mtime = int(st.st_mtime)
            atime = int(st.st_atime)
        except OSError:
            mtime = 0
            atime = 0

        items.append({
            "trash_path": str(entry),
            "name": entry.name,
            "original_path": original_path,
            "size": size,
            "size_human": _format_size(size),
            "modified": mtime,
            "accessed": atime,
            "is_dir": entry.is_dir() and not entry.is_symlink(),
        })

    return items


def _file_size(p):
    try:
        return p.lstat().st_size
    except OSError:
        return 0


def _dir_size(p):
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


def restore(trash_path):
    """Restore a trashed item to its original location."""
    tp = Path(trash_path)
    if not tp.exists() and not tp.is_symlink():
        raise FileNotFoundError(f"Trash item not found: {trash_path}")

    meta = _read_meta(tp)
    original = meta.get("original_path")
    if not original:
        raise ValueError(f"No original path metadata for: {trash_path}")

    dest = Path(original)
    if dest.exists():
        raise FileExistsError(f"Destination already exists: {original}")

    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(tp), str(dest))

    mp = _meta_path(tp)
    if mp.exists():
        mp.unlink()

    return str(dest)


def delete(trash_path):
    """Permanently delete a trashed item."""
    tp = Path(trash_path)
    if not tp.exists() and not tp.is_symlink():
        raise FileNotFoundError(f"Trash item not found: {trash_path}")

    if tp.is_dir() and not tp.is_symlink():
        shutil.rmtree(str(tp))
    else:
        tp.unlink()

    mp = _meta_path(tp)
    if mp.exists():
        mp.unlink()
