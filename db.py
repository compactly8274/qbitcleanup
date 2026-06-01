import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
import config

_lock = threading.Lock()


def _conn():
    c = sqlite3.connect(config.DB_PATH, timeout=15, check_same_thread=False)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    return c


def init():
    Path(config.DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with _conn() as c:
        c.executescript("""
            CREATE TABLE IF NOT EXISTS orphan_cache (
                path          TEXT PRIMARY KEY,
                name          TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                size          INTEGER NOT NULL,
                size_human    TEXT NOT NULL,
                modified      INTEGER NOT NULL,
                accessed      INTEGER NOT NULL DEFAULT 0,
                is_dir        INTEGER NOT NULL,
                first_seen    INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS scan_state (
                id        INTEGER PRIMARY KEY CHECK (id = 1),
                last_scan INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS ignore_list (
                path      TEXT PRIMARY KEY,
                added_at  INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS jobs (
                id           TEXT PRIMARY KEY,
                type         TEXT NOT NULL,
                payload      TEXT NOT NULL,
                status       TEXT NOT NULL DEFAULT 'queued',
                created_at   INTEGER NOT NULL,
                updated_at   INTEGER NOT NULL,
                result       TEXT,
                total        INTEGER NOT NULL DEFAULT 0,
                progress     INTEGER NOT NULL DEFAULT 0,
                started_at   INTEGER NOT NULL DEFAULT 0,
                current_file TEXT
            );
            CREATE TABLE IF NOT EXISTS scan_history (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                scanned_at   INTEGER NOT NULL,
                orphan_count INTEGER NOT NULL,
                orphan_size  INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS cleanup_events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                occurred_at INTEGER NOT NULL,
                action      TEXT NOT NULL,
                item_count  INTEGER NOT NULL,
                bytes_freed INTEGER NOT NULL
            );
            INSERT OR IGNORE INTO scan_state (id, last_scan) VALUES (1, 0);
        """)
    # Migrate older databases missing newer columns
    with _conn() as c:
        for col, defval in [("accessed", "0"), ("first_seen", "0")]:
            try:
                c.execute(f"ALTER TABLE orphan_cache ADD COLUMN {col} INTEGER NOT NULL DEFAULT {defval}")
            except sqlite3.OperationalError:
                pass
        for col, defval in [("total", "0"), ("progress", "0"), ("started_at", "0")]:
            try:
                c.execute(f"ALTER TABLE jobs ADD COLUMN {col} INTEGER NOT NULL DEFAULT {defval}")
            except sqlite3.OperationalError:
                pass
        try:
            c.execute("ALTER TABLE jobs ADD COLUMN current_file TEXT")
        except sqlite3.OperationalError:
            pass
    # Reset jobs left in 'running' state from a previous session (e.g. container restart)
    with _conn() as c:
        c.execute(
            "UPDATE jobs SET status='queued', updated_at=? WHERE status='running'",
            (int(time.time()),),
        )


def last_scan_time():
    with _conn() as c:
        row = c.execute("SELECT last_scan FROM scan_state WHERE id = 1").fetchone()
        return row["last_scan"] if row else 0


def cache_is_fresh():
    return (int(time.time()) - last_scan_time()) < config.SCAN_CACHE_TTL


def get_cached_orphans():
    with _conn() as c:
        rows = c.execute(
            "SELECT path, name, relative_path, size, size_human, modified, accessed, is_dir, first_seen "
            "FROM orphan_cache ORDER BY size DESC"
        ).fetchall()
        return [dict(r) | {"is_dir": bool(r["is_dir"])} for r in rows]


def set_orphan_cache(orphans):
    """Replace cache contents, preserving first_seen for previously known paths.
    Returns (timestamp, set_of_newly_found_paths)."""
    now = int(time.time())
    with _lock, _conn() as c:
        existing = {
            row["path"]: row["first_seen"] or now
            for row in c.execute("SELECT path, first_seen FROM orphan_cache").fetchall()
        }
        prev_paths = set(existing)
        new_paths = {o["path"] for o in orphans}

        c.execute("DELETE FROM orphan_cache")
        c.executemany(
            "INSERT INTO orphan_cache VALUES (?,?,?,?,?,?,?,?,?)",
            [
                (o["path"], o["name"], o["relative_path"],
                 o["size"], o["size_human"], o["modified"],
                 o.get("accessed", 0), int(o["is_dir"]),
                 existing.get(o["path"], now))
                for o in orphans
            ],
        )
        c.execute("UPDATE scan_state SET last_scan = ? WHERE id = 1", (now,))

    return now, new_paths - prev_paths


def get_auto_trash_candidates():
    if not config.AUTO_TRASH_DAYS:
        return []
    cutoff = int(time.time()) - config.AUTO_TRASH_DAYS * 86400
    with _conn() as c:
        rows = c.execute(
            "SELECT path FROM orphan_cache WHERE first_seen > 0 AND first_seen <= ?", (cutoff,)
        ).fetchall()
        return [r["path"] for r in rows]


def remove_from_cache(path):
    with _conn() as c:
        c.execute("DELETE FROM orphan_cache WHERE path = ?", (path,))


def remove_subtree_from_cache(path):
    """Remove cached entries matching the given path/pattern.

    path//  → remove only the folder entry itself (folder-only scope)
    path/*  → remove all children (contents-only scope, glob)
    path    → remove folder and all children (full scope)
    """
    import fnmatch as _fnmatch
    if path.endswith('//'):
        clean = path.rstrip('/')
        with _conn() as c:
            c.execute("DELETE FROM orphan_cache WHERE path = ?", (clean,))
        return
    has_glob = any(c in path for c in '*?[')
    prefix = path.rstrip('/') + '/'
    with _conn() as c:
        rows = c.execute("SELECT path FROM orphan_cache").fetchall()
        if has_glob:
            targets = [r['path'] for r in rows if _fnmatch.fnmatchcase(r['path'], path)]
        else:
            targets = [r['path'] for r in rows
                       if r['path'] == path or r['path'].startswith(prefix)]
        if targets:
            c.executemany("DELETE FROM orphan_cache WHERE path = ?",
                          [(p,) for p in targets])


def invalidate():
    with _conn() as c:
        c.execute("UPDATE scan_state SET last_scan = 0 WHERE id = 1")


# ── Ignore list ───────────────────────────────────────────────────────────────

def get_ignore_list():
    with _conn() as c:
        rows = c.execute("SELECT path, added_at FROM ignore_list ORDER BY path").fetchall()
        return [dict(r) for r in rows]


def get_ignore_paths():
    with _conn() as c:
        return {r["path"] for r in c.execute("SELECT path FROM ignore_list").fetchall()}


def add_to_ignore(path):
    with _conn() as c:
        c.execute("INSERT OR REPLACE INTO ignore_list VALUES (?, ?)", (path, int(time.time())))


def remove_from_ignore(path):
    with _conn() as c:
        c.execute("DELETE FROM ignore_list WHERE path = ?", (path,))


# ── Job queue ─────────────────────────────────────────────────────────────────

def enqueue_job(job_type, paths):
    job_id = str(uuid.uuid4())
    now = int(time.time())
    with _conn() as c:
        c.execute(
            "INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (job_id, job_type, json.dumps({"paths": paths}), "queued", now, now, None,
             len(paths), 0, 0, None),
        )
    return job_id


def claim_next_job():
    with _lock:
        with _conn() as c:
            row = c.execute(
                "SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1"
            ).fetchone()
            if not row:
                return None
            now = int(time.time())
            c.execute(
                "UPDATE jobs SET status='running', updated_at=?, started_at=? WHERE id=?",
                (now, now, row["id"]),
            )
            return dict(row)


def update_job_progress(job_id, done):
    now = int(time.time())
    with _conn() as c:
        c.execute(
            "UPDATE jobs SET progress=?, updated_at=?, current_file=NULL WHERE id=?",
            (done, now, job_id),
        )


def update_job_current_file(job_id, filename):
    now = int(time.time())
    with _conn() as c:
        c.execute(
            "UPDATE jobs SET current_file=?, updated_at=? WHERE id=?",
            (filename, now, job_id),
        )


def complete_job(job_id, result):
    now = int(time.time())
    with _conn() as c:
        c.execute(
            "UPDATE jobs SET status='done', updated_at=?, result=? WHERE id=?",
            (now, json.dumps(result), job_id),
        )


def fail_job(job_id, error):
    now = int(time.time())
    with _conn() as c:
        c.execute(
            "UPDATE jobs SET status='error', updated_at=?, result=? WHERE id=?",
            (now, json.dumps({"error": error}), job_id),
        )


def get_job(job_id):
    with _conn() as c:
        row = c.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        if d.get("result"):
            d["result"] = json.loads(d["result"])
        return d


def get_pending_jobs():
    with _conn() as c:
        rows = c.execute(
            "SELECT id, type, status, created_at, started_at, total, progress, current_file FROM jobs "
            "WHERE status IN ('queued','running') ORDER BY created_at"
        ).fetchall()
        return [dict(r) for r in rows]


def is_job_cancelled(job_id):
    with _conn() as c:
        row = c.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
        return bool(row and row["status"] == "cancelled")


def cancel_job(job_id):
    now = int(time.time())
    with _conn() as c:
        c.execute(
            "UPDATE jobs SET status='cancelled', updated_at=? "
            "WHERE id=? AND status IN ('queued','running')",
            (now, job_id),
        )


def cancel_all_pending_jobs():
    now = int(time.time())
    with _conn() as c:
        c.execute(
            "UPDATE jobs SET status='cancelled', updated_at=? "
            "WHERE status IN ('queued','running')",
            (now,),
        )


def prune_jobs():
    cutoff = int(time.time()) - 3600
    with _conn() as c:
        c.execute(
            "DELETE FROM jobs WHERE status IN ('done','error','cancelled') AND updated_at < ?",
            (cutoff,),
        )


def cleanup_stale_cache():
    """Remove orphan cache entries whose paths no longer exist on disk."""
    with _conn() as c:
        rows = c.execute("SELECT path FROM orphan_cache").fetchall()
    stale = [r["path"] for r in rows if not Path(r["path"]).exists()]
    if stale:
        with _conn() as c:
            c.executemany("DELETE FROM orphan_cache WHERE path=?", [(p,) for p in stale])
    return len(stale)


def record_scan(orphan_count, orphan_size):
    now = int(time.time())
    cutoff = now - 90 * 86400
    with _conn() as c:
        c.execute(
            "INSERT INTO scan_history (scanned_at, orphan_count, orphan_size) VALUES (?,?,?)",
            (now, orphan_count, orphan_size),
        )
        c.execute("DELETE FROM scan_history WHERE scanned_at < ?", (cutoff,))


def record_cleanup(action, item_count, bytes_freed):
    now = int(time.time())
    cutoff = now - 90 * 86400
    with _conn() as c:
        c.execute(
            "INSERT INTO cleanup_events (occurred_at, action, item_count, bytes_freed) VALUES (?,?,?,?)",
            (now, action, item_count, bytes_freed),
        )
        c.execute("DELETE FROM cleanup_events WHERE occurred_at < ?", (cutoff,))


def get_scan_history(days=30):
    cutoff = int(time.time()) - days * 86400
    with _conn() as c:
        rows = c.execute(
            "SELECT scanned_at, orphan_count, orphan_size FROM scan_history "
            "WHERE scanned_at >= ? ORDER BY scanned_at",
            (cutoff,),
        ).fetchall()
        return [dict(r) for r in rows]


def get_cleanup_history(days=30):
    cutoff = int(time.time()) - days * 86400
    with _conn() as c:
        rows = c.execute(
            "SELECT occurred_at, action, item_count, bytes_freed FROM cleanup_events "
            "WHERE occurred_at >= ? ORDER BY occurred_at",
            (cutoff,),
        ).fetchall()
        return [dict(r) for r in rows]
