import sqlite3
import threading
import time
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
                is_dir        INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS scan_state (
                id        INTEGER PRIMARY KEY CHECK (id = 1),
                last_scan INTEGER NOT NULL DEFAULT 0
            );
            INSERT OR IGNORE INTO scan_state (id, last_scan) VALUES (1, 0);
        """)
    # Migrate existing databases that predate the accessed column
    with _conn() as c:
        try:
            c.execute("ALTER TABLE orphan_cache ADD COLUMN accessed INTEGER NOT NULL DEFAULT 0")
        except sqlite3.OperationalError:
            pass  # column already exists


def last_scan_time():
    with _conn() as c:
        row = c.execute("SELECT last_scan FROM scan_state WHERE id = 1").fetchone()
        return row["last_scan"] if row else 0


def cache_is_fresh():
    age = int(time.time()) - last_scan_time()
    return age < config.SCAN_CACHE_TTL


def get_cached_orphans():
    with _conn() as c:
        rows = c.execute(
            "SELECT path, name, relative_path, size, size_human, modified, accessed, is_dir "
            "FROM orphan_cache ORDER BY size DESC"
        ).fetchall()
        return [dict(r) | {"is_dir": bool(r["is_dir"])} for r in rows]


def set_orphan_cache(orphans):
    now = int(time.time())
    with _lock, _conn() as c:
        c.execute("DELETE FROM orphan_cache")
        c.executemany(
            "INSERT INTO orphan_cache VALUES (?,?,?,?,?,?,?,?)",
            [
                (o["path"], o["name"], o["relative_path"],
                 o["size"], o["size_human"], o["modified"],
                 o.get("accessed", 0), int(o["is_dir"]))
                for o in orphans
            ],
        )
        c.execute("UPDATE scan_state SET last_scan = ? WHERE id = 1", (now,))
    return now


def remove_from_cache(path):
    with _conn() as c:
        c.execute("DELETE FROM orphan_cache WHERE path = ?", (path,))


def invalidate():
    with _conn() as c:
        c.execute("UPDATE scan_state SET last_scan = 0 WHERE id = 1")
