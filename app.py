import json
import logging
import shutil
import threading
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


# ── Background job worker ─────────────────────────────────────────────────────

def _execute_job(job):
    payload = json.loads(job["payload"])
    paths = payload.get("paths", [])
    jtype = job["type"]
    job_id = job["id"]

    if jtype == "move_to_trash":
        moved, errors = [], []
        for i, p in enumerate(paths):
            try:
                dest = trash_mod.move_to_trash(p)
                db.remove_from_cache(p)
                moved.append({"from": p, "to": dest})
            except Exception as e:
                errors.append({"path": p, "error": str(e)})
            db.update_job_progress(job_id, i + 1)
        return {"moved": moved, "errors": errors}

    if jtype == "restore":
        restored, errors = [], []
        for i, p in enumerate(paths):
            try:
                dest = trash_mod.restore(p)
                restored.append({"from": p, "to": dest})
            except Exception as e:
                errors.append({"path": p, "error": str(e)})
            db.update_job_progress(job_id, i + 1)
        return {"restored": restored, "errors": errors}

    if jtype == "delete":
        deleted, errors = [], []
        for i, p in enumerate(paths):
            try:
                trash_mod.delete(p)
                deleted.append(p)
            except Exception as e:
                errors.append({"path": p, "error": str(e)})
            db.update_job_progress(job_id, i + 1)
        return {"deleted": deleted, "errors": errors}

    raise ValueError(f"Unknown job type: {jtype}")


def _job_worker():
    while True:
        try:
            job = db.claim_next_job()
            if job:
                n = len(json.loads(job["payload"]).get("paths", []))
                log.info("Job %s type=%s paths=%d", job["id"][:8], job["type"], n)
                try:
                    result = _execute_job(job)
                    db.complete_job(job["id"], result)
                    log.info("Job %s done", job["id"][:8])
                except Exception as e:
                    log.error("Job %s failed: %s", job["id"][:8], e)
                    db.fail_job(job["id"], str(e))
            else:
                db.prune_jobs()
                time.sleep(0.5)
        except Exception as e:
            log.error("Job worker crash: %s", e)
            time.sleep(1)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _fresh_scan():
    paths = qbit.get_torrent_paths()
    if paths is None:
        return None, "Failed to fetch torrent list from qBittorrent"

    ignore_paths = db.get_ignore_paths()
    result = scanner.scan_orphans(paths, ignore_paths=ignore_paths,
                                  min_age_days=config.MIN_ORPHAN_AGE_DAYS)
    if isinstance(result, dict) and "error" in result:
        return None, result["error"]

    _, newly_found = db.set_orphan_cache(result)
    log.info("Scan complete: %d orphan(s), %d new", len(result), len(newly_found))

    if config.AUTO_TRASH_DAYS:
        for path in db.get_auto_trash_candidates():
            try:
                trash_mod.move_to_trash(path)
                db.remove_from_cache(path)
                log.info("Auto-trashed (age limit): %s", path)
            except Exception as e:
                log.warning("Auto-trash failed for %s: %s", path, e)

    if config.WEBHOOK_URL and newly_found:
        _fire_webhook(result, newly_found)

    return result, None


def _fire_webhook(orphans, newly_found):
    try:
        import requests as req
        payload = {
            "event": "new_orphans_found",
            "new_count": len(newly_found),
            "total_orphans": len(orphans),
            "total_size_bytes": sum(o["size"] for o in orphans),
            "new_paths": sorted(newly_found),
        }
        req.post(config.WEBHOOK_URL, json=payload, timeout=5)
        log.info("Webhook fired: %d new orphan(s)", len(newly_found))
    except Exception as e:
        log.warning("Webhook failed: %s", e)


def _disk_info():
    try:
        du = shutil.disk_usage(config.DOWNLOADS_DIR)
        orphan_size = sum(o["size"] for o in db.get_cached_orphans())
        return {"total": du.total, "used": du.used, "free": du.free,
                "orphan_size": orphan_size}
    except OSError:
        return {}


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def api_status():
    status = qbit.get_status()
    orphans = db.get_cached_orphans()
    return jsonify({
        "connected": status["connected"],
        "version": status["version"],
        "error": status.get("error"),
        "orphan_count": len(orphans),
        "orphan_size": sum(o["size"] for o in orphans),
        "trash_count": len(trash_mod.list_trash()),
        "ignored_count": len(db.get_ignore_list()),
        "last_scan": db.last_scan_time(),
        "cache_ttl": config.SCAN_CACHE_TTL,
        "disk": _disk_info(),
        "downloads_dir": config.DOWNLOADS_DIR,
        "trash_dir": config.TRASH_DIR,
    })


@app.route("/api/orphans")
def api_orphans():
    force = request.args.get("refresh", "").lower() in ("1", "true")

    if not force and db.cache_is_fresh():
        orphans = db.get_cached_orphans()
        return jsonify({"orphans": orphans, "last_scan": db.last_scan_time(), "cached": True})

    status = qbit.get_status()
    if not status["connected"]:
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
    paths = data.get("paths") or ([data["path"]] if data.get("path") else None)
    targets = paths if paths else [o["path"] for o in db.get_cached_orphans()]
    job_id = db.enqueue_job("move_to_trash", targets)
    return jsonify({"job_id": job_id, "queued": True, "count": len(targets)})


@app.route("/api/trash")
def api_trash():
    return jsonify(trash_mod.list_trash())


@app.route("/api/trash/restore", methods=["POST"])
def api_trash_restore():
    data = request.get_json(silent=True) or {}
    paths = data.get("paths") or ([data["path"]] if data.get("path") else None)
    items = trash_mod.list_trash()
    targets = paths if paths else [i["trash_path"] for i in items]
    job_id = db.enqueue_job("restore", targets)
    return jsonify({"job_id": job_id, "queued": True, "count": len(targets)})


@app.route("/api/trash/delete", methods=["POST"])
def api_trash_delete():
    data = request.get_json(silent=True) or {}
    paths = data.get("paths") or ([data["path"]] if data.get("path") else None)
    items = trash_mod.list_trash()
    targets = paths if paths else [i["trash_path"] for i in items]
    job_id = db.enqueue_job("delete", targets)
    return jsonify({"job_id": job_id, "queued": True, "count": len(targets)})


@app.route("/api/jobs")
def api_jobs():
    return jsonify(db.get_pending_jobs())


@app.route("/api/jobs/<job_id>")
def api_job(job_id):
    job = db.get_job(job_id)
    if not job:
        return jsonify({"error": "not found"}), 404
    return jsonify(job)


@app.route("/api/ignore")
def api_ignore():
    return jsonify(db.get_ignore_list())


@app.route("/api/ignore/add", methods=["POST"])
def api_ignore_add():
    data = request.get_json(silent=True) or {}
    paths = data.get("paths") or ([data["path"]] if data.get("path") else [])
    if not paths:
        return jsonify({"error": "path or paths required"}), 400
    for p in paths:
        db.add_to_ignore(p)
        db.remove_from_cache(p)
    return jsonify({"ok": True, "count": len(paths)})


@app.route("/api/ignore/remove", methods=["POST"])
def api_ignore_remove():
    data = request.get_json(silent=True) or {}
    path = data.get("path")
    if not path:
        return jsonify({"error": "path required"}), 400
    db.remove_from_ignore(path)
    db.invalidate()
    return jsonify({"ok": True})
