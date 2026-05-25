import errno
import json
import logging
import os
import shutil
import time
from pathlib import Path
import config

log = logging.getLogger(__name__)


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


def _rename(src, dest):
    """os.rename wrapper; raises OSError with errno.EXDEV on cross-device."""
    os.rename(str(src), str(dest))


def _copy_move(src, dest):
    """Full copy+delete fallback for cross-device moves."""
    if src.is_dir():
        shutil.copytree(str(src), str(dest))
        shutil.rmtree(str(src))
    else:
        shutil.copy2(str(src), str(dest))
        src.unlink()


def _unique_dest(dest):
    """Return dest unchanged if no collision, or dest.N for the first free N."""
    if not dest.exists() and not _meta_path(dest).exists():
        return dest
    parent, base = dest.parent, dest.name
    i = 1
    while (parent / f"{base}.{i}").exists() or _meta_path(parent / f"{base}.{i}").exists():
        i += 1
    return parent / f"{base}.{i}"


def _local_trash_dir(src):
    """Return a .qbit-trash sibling of src that is on the same device."""
    d = src.parent / '.qbit-trash'
    d.mkdir(parents=True, exist_ok=True)
    return d


def move_to_trash(src_path):
    """Move src_path into TRASH_DIR (or a local .qbit-trash on EXDEV). Returns trash path."""
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

    dest = _unique_dest(trash / rel)
    dest.parent.mkdir(parents=True, exist_ok=True)

    t0 = time.monotonic()
    cross_device = False
    try:
        _rename(src, dest)
    except OSError as e:
        if e.errno != errno.EXDEV:
            raise
        # Source is on a different ZFS dataset than TRASH_DIR.
        # Fall back to a .qbit-trash dir inside the source's own directory
        # (always on the same dataset as the source file — rename will work).
        cross_device = True
        local_dir = _local_trash_dir(src)
        dest = _unique_dest(local_dir / src.name)
        try:
            _rename(src, dest)
        except OSError as e2:
            if e2.errno != errno.EXDEV:
                raise
            # Should not happen, but handle gracefully
            _copy_move(src, dest)

    elapsed = time.monotonic() - t0
    if cross_device:
        log.warning(
            "Trashed %s to local trash in %.2fs (cross-dataset: %s → %s). "
            "To use the central trash dir, ensure DOWNLOADS_DIR and TRASH_DIR "
            "are on the same ZFS dataset.",
            src.name, elapsed, src.parent, dest.parent,
        )
    else:
        log.info("Trashed %s in %.2fs", src.name, elapsed)

    _write_meta(dest, src)
    return str(dest)


def list_trash():
    """Return items from TRASH_DIR and any local .qbit-trash dirs under DOWNLOADS_DIR."""
    trash_dirs = []

    primary = Path(config.TRASH_DIR)
    if primary.exists():
        trash_dirs.append(primary)

    # Discover local .qbit-trash dirs created for cross-dataset moves
    downloads = Path(config.DOWNLOADS_DIR)
    if downloads.exists():
        try:
            for p in downloads.rglob('.qbit-trash'):
                if p.is_dir() and p.resolve() != primary.resolve():
                    trash_dirs.append(p)
        except (PermissionError, OSError):
            pass

    seen = set()
    items = []
    for trash_dir in trash_dirs:
        try:
            entries = sorted(trash_dir.iterdir(), key=lambda e: e.name.lower())
        except OSError:
            continue
        for entry in entries:
            key = str(entry.resolve())
            if key in seen:
                continue
            seen.add(key)
            if entry.name.startswith('.') or entry.name.endswith('.meta.json'):
                continue

            meta = _read_meta(entry)
            original_path = meta.get("original_path", "")
            size = _dir_size(entry) if entry.is_dir() else _file_size(entry)
            try:
                st = entry.stat()
                mtime = int(st.st_mtime)
                atime = int(st.st_atime)
            except OSError:
                mtime = atime = 0

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

    t0 = time.monotonic()
    try:
        _rename(tp, dest)
    except OSError as e:
        if e.errno != errno.EXDEV:
            raise
        _copy_move(tp, dest)
        log.warning("Restored (copy+delete) %s in %.1fs", tp.name, time.monotonic() - t0)
    else:
        log.info("Restored %s in %.2fs", tp.name, time.monotonic() - t0)

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
