import logging
import time
from flask import Flask, jsonify, request, render_template
import config
import db
import qbit
import scanner
import trash as trash_mod

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger(__name__)

app = Flask(__name__)

with app.app_context():
    db.init()


def _fresh_scan():
    """Fetch torrent paths from qBit, scan filesystem, update cache. Returns (orphans, error)."""
    paths = qbit.get_torrent_paths()
    if paths is None:
        return None, "Failed to fetch torrent list from qBittorrent"
    result = scanner.scan_orphans(paths)
    if isinstance(result, dict) and "error" in result:
        return None, result["error"]
    db.set_orphan_cache(result)
    log.info("Scan complete: %d orphan(s) found", len(result))
    return result, None


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def api_status():
    status = qbit.get_status()
    orphan_count = len(db.get_cached_orphans())
    trash_count = len(trash_mod.list_trash())
    last_scan = db.last_scan_time()

    return jsonify({
        "connected": status["connected"],
        "version": status["version"],
        "error": status.get("error"),
        "orphan_count": orphan_count,
        "trash_count": trash_count,
        "last_scan": last_scan,
        "cache_ttl": config.SCAN_CACHE_TTL,
        "downloads_dir": config.DOWNLOADS_DIR,
        "trash_dir": config.TRASH_DIR,
    })


@app.route("/api/orphans")
def api_orphans():
    force = request.args.get("refresh", "").lower() in ("1", "true")

    if not force and db.cache_is_fresh():
        orphans = db.get_cached_orphans()
        log.debug("Returning %d orphan(s) from cache", len(orphans))
        return jsonify({"orphans": orphans, "last_scan": db.last_scan_time(), "cached": True})

    status = qbit.get_status()
    if not status["connected"]:
        # Return stale cache rather than nothing if qBit is temporarily offline
        orphans = db.get_cached_orphans()
        return jsonify({
            "orphans": orphans,
            "last_scan": db.last_scan_time(),
            "cached": True,
            "warning": f"qBittorrent offline — showing cached results. {status.get('error', '')}".strip(),
        })

    orphans, err = _fresh_scan()
    if err:
        return jsonify({"error": err}), 502

    return jsonify({"orphans": orphans, "last_scan": db.last_scan_time(), "cached": False})


@app.route("/api/orphans/move", methods=["POST"])
def api_orphans_move():
    data = request.get_json(silent=True) or {}
    path = data.get("path")

    if path:
        targets = [path]
    else:
        targets = [o["path"] for o in db.get_cached_orphans()]

    moved, errors = [], []
    for t in targets:
        try:
            dest = trash_mod.move_to_trash(t)
            db.remove_from_cache(t)
            moved.append({"from": t, "to": dest})
        except Exception as e:
            errors.append({"path": t, "error": str(e)})

    return jsonify({"moved": moved, "errors": errors})


@app.route("/api/trash")
def api_trash():
    return jsonify(trash_mod.list_trash())


@app.route("/api/trash/restore", methods=["POST"])
def api_trash_restore():
    data = request.get_json(silent=True) or {}
    path = data.get("path")

    items = trash_mod.list_trash()
    targets = [i["trash_path"] for i in items] if path is None else [path]

    restored, errors = [], []
    for t in targets:
        try:
            dest = trash_mod.restore(t)
            restored.append({"from": t, "to": dest})
        except Exception as e:
            errors.append({"path": t, "error": str(e)})

    return jsonify({"restored": restored, "errors": errors})


@app.route("/api/trash/delete", methods=["POST"])
def api_trash_delete():
    data = request.get_json(silent=True) or {}
    path = data.get("path")

    items = trash_mod.list_trash()
    targets = [i["trash_path"] for i in items] if path is None else [path]

    deleted, errors = [], []
    for t in targets:
        try:
            trash_mod.delete(t)
            deleted.append(t)
        except Exception as e:
            errors.append({"path": t, "error": str(e)})

    return jsonify({"deleted": deleted, "errors": errors})
