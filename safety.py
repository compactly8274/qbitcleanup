"""Extra safety/verification helpers for orphan cleanup."""
import logging
import os
from pathlib import Path
import config

log = logging.getLogger(__name__)


# Paths and patterns that are commonly used by cross-seed / link farms / staging tools.
# These are excluded from orphan detection regardless of ignore list.
CROSS_SEED_PATTERNS = (
    "cross-seed",
    ".cross-seed",
    ".xseed",
    "xseed",
    ".link-farm",
    "link-farm",
)


def is_cross_seed_path(path):
    """Return True if the path looks like a cross-seed staging/link-farm directory."""
    s = str(path).lower()
    return any(pat.lower() in s for pat in CROSS_SEED_PATTERNS)


def is_hardlinked(path):
    """Return True if the file/directory has more than one hardlink (still referenced elsewhere)."""
    p = Path(path)
    try:
        st = p.lstat()
    except OSError:
        return False
    # Directories on Linux usually have high link counts (subdirs), so only count files.
    if p.is_dir() and not p.is_symlink():
        # If it's a dir, sample the biggest file inside for link count.
        sample = None
        try:
            for child in p.rglob("*"):
                if child.is_file() and not child.is_symlink():
                    if sample is None or child.stat().st_size > sample.stat().st_size:
                        sample = child
        except (OSError, PermissionError):
            pass
        if sample is None:
            return False  # empty dir — safe
        st = sample.lstat()
    return st.st_nlink > 1


def has_hardlink_descendant(directory):
    """Return True if any real file under directory has nlink > 1."""
    try:
        for root, _, files in os.walk(directory):
            for f in files:
                fp = os.path.join(root, f)
                try:
                    if os.lstat(fp).st_nlink > 1:
                        return True
                except (OSError, PermissionError):
                    pass
    except (OSError, PermissionError):
        pass
    return False


def augment_orphan_info(entry):
    """Add safety metadata to a scanner orphan entry. Mutates in place."""
    path = entry["path"]
    real_path = path.replace("/downloads/", config.DOWNLOADS_DIR + "/", 1)
    entry["is_cross_seed"] = is_cross_seed_path(path)
    try:
        entry["is_hardlinked"] = is_hardlinked(real_path)
        entry["has_hardlink_descendant"] = has_hardlink_descendant(real_path)
    except Exception as e:
        log.debug("Could not determine hardlink status for %s: %s", path, e)
        entry["is_hardlinked"] = False
        entry["has_hardlink_descendant"] = False
    return entry


def is_safe_to_move(entry, claimed_paths=None):
    """Return (safe: bool, reason: str) for an orphan entry."""
    path = entry["path"]
    if entry.get("is_cross_seed"):
        return False, "cross-seed / link-farm path"
    if entry.get("is_hardlinked") or entry.get("has_hardlink_descendant"):
        return False, "hardlinked elsewhere"
    if claimed_paths is not None:
        p_norm = path.rstrip("/")
        claimed_norm = {p.rstrip("/") for p in claimed_paths}
        if p_norm in claimed_norm:
            return False, "claimed by active qBittorrent torrent"
        if any(c.startswith(p_norm + "/") for c in claimed_norm):
            return False, "parent of active qBittorrent torrent content"
    return True, ""
