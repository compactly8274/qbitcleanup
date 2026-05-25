import json
import logging
import shutil
import threading
import time
from pathlib import Path
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

_worker_thread = None
_worker_lock = threading.Lock()
_scan_lock = threading.Lock()
_scan_running = False
_last_purge_check = 0


def _startup_cleanup():
    # Warn immediately if DOWNLOADS_DIR and TRASH_DIR are on different devices
    try:
        import os as _os
        dl_dev = _os.stat(config.DOWNLOADS_DIR).st_dev
        trash = config.TRASH_DIR
        import pathlib as _pl
        _pl.Path(trash).mkdir(parents=True, exist_ok=True)
        tr_dev = _os.stat(trash).st_dev
        if dl_dev != tr_dev:
            log.warning(
                "TRASH_DIR (%s) is on a different filesystem/dataset than DOWNLOADS_DIR (%s). "
                "Files on sub-datasets will be trashed locally (in a .qbit-trash folder next "
                "to the source file) via instant rename. Files on the same dataset as "
                "DOWNLOADS_DIR root will use copy+delete to reach TRASH_DIR.",
                config.TRASH_DIR, config.DOWNLOADS_DIR,
            )
        else:
            log.info(
                "Trash dir is on the same device as downloads — moves will be instant (rename)."
            )
    except Exception as e:
        log.warning("Device check failed: %s", e)

    try:
        n = db.cleanup_stale_cache()
        if n:
            log.info("Startup cleanup: removed %d stale orphan cache entries", n)
    except Exception as e:
        log.warning("Startup cleanup failed: %s", e)


def _ensure_worker():
    global _worker_thread
    if _worker_thread is not None and _worker_thread.is_alive():
        return
    with _worker_lock:
        if _worker_thread is not None and _worker_thread.is_alive():
            return
        log.info("Starting job worker thread")
        threading.Thread(target=_startup_cleanup, daemon=True, name="startup-cleanup").start()
        _worker_thread = threading.Thread(target=_job_worker, daemon=True, name="job-worker")
        _worker_thread.start()

def _execute_job(job):
    payload = json.loads(job["payload"])
    paths = payload.get("paths", [])
    jtype = job["type"]
    job_id = job["id"]

    if jtype == "move_to_trash":
        moved, not_found, errors = [], [], []
        for i, p in enumerate(paths):
            if db.is_job_cancelled(job_id):
                break
            clean_cache = False
            try:
                db.update_job_current_file(job_id, p.split("/")[-1])
            except Exception:
                pass
            clean_cache = False
            try:
                dest = trash_mod.move_to_trash(p)
                moved.append({"from": p, "to": dest})
                clean_cache = True
            except FileNotFoundError:
                not_found.append(p)
                clean_cache = True  # ghost entry — scrub it
            except Exception as e:
                log.warning("Job %s: failed to trash %s: %s", job_id[:8], p, e)
                errors.append({"path": p, "error": str(e)})
            if clean_cache:
                try:
                    db.remove_from_cache(p)
                except Exception:
                    pass
            try:
                db.update_job_progress(job_id, i + 1)
            except Exception:
                pass
        if not_found:
            log.info("Job %s: %d path(s) already gone (removed from cache)", job_id[:8], len(not_found))
        return {"moved": moved, "not_found": not_found, "errors": errors}

    if jtype == "restore":
        restored, not_found, errors = [], [], []
        for i, p in enumerate(paths):
            if db.is_job_cancelled(job_id):
                break
            try:
                db.update_job_current_file(job_id, p.split("/")[-1])
            except Exception:
                pass
            try:
                dest = trash_mod.restore(p)
                restored.append({"from": p, "to": dest})
            except FileNotFoundError:
                not_found.append(p)
            except Exception as e:
                log.warning("Job %s: failed to restore %s: %s", job_id[:8], p, e)
                errors.append({"path": p, "error": str(e)})
            try:
                db.update_job_progress(job_id, i + 1)
            except Exception:
                pass
        return {"restored": restored, "not_found": not_found, "errors": errors}

    if jtype == "delete":
        deleted, errors = [], []
        for i, p in enumerate(paths):
            if db.is_job_cancelled(job_id):
                break
            try:
                db.update_job_current_file(job_id, p.split("/")[-1])
            except Exception:
                pass
            try:
                trash_mod.delete(p)
                deleted.append(p)
            except FileNotFoundError:
                deleted.append(p)  # already gone, count as success
            except Exception as e:
                log.warning("Job %s: failed to delete %s: %s", job_id[:8], p, e)
                errors.append({"path": p, "error": str(e)})
            try:
                db.update_job_progress(job_id, i + 1)
            except Exception:
                pass
        return {"deleted": deleted, "errors": errors}

    raise ValueError(f"Unknown job type: {jtype}")


def _job_worker():
    global _scan_running, _last_purge_check
    while True:
        try:
            job = db.claim_next_job()
            if job:
                n = len(json.loads(job["payload"]).get("paths", []))
                log.info("Job %s type=%s paths=%d", job["id"][:8], job["type"], n)
                try:
                    result = _execute_job(job)
                    if not db.is_job_cancelled(job["id"]):
                        db.complete_job(job["id"], result)
                        _record_job_stats(job["type"], result)
                    log.info("Job %s done", job["id"][:8])
                except Exception as e:
                    log.error("Job %s failed: %s", job["id"][:8], e)
                    if not db.is_job_cancelled(job["id"]):
                        db.fail_job(job["id"], str(e))
            else:
                db.prune_jobs()
                _maybe_auto_scan()
                _maybe_purge_trash()
                time.sleep(0.5)
        except Exception as e:
            log.error("Job worker crash: %s", e)
            time.sleep(1)


def _record_job_stats(jtype, result):
    try:
        if jtype == "move_to_trash" and result.get("moved"):
            bytes_freed = 0
            for m in result["moved"]:
                try:
                    dest = Path(m["to"])
                    if dest.is_dir() and not dest.is_symlink():
                        bytes_freed += sum(
                            f.stat().st_size for f in dest.rglob("*")
                            if f.is_file() and not f.is_symlink()
                        )
                    elif dest.exists():
                        bytes_freed += dest.stat().st_size
                except OSError:
                    pass
            db.record_cleanup("trash", len(result["moved"]), bytes_freed)
        elif jtype == "delete" and result.get("deleted"):
            db.record_cleanup("delete", len(result["deleted"]), 0)
    except Exception as e:
        log.warning("Failed to record job stats: %s", e)


def _maybe_auto_scan():
    global _scan_running
    if not config.SCAN_INTERVAL_HOURS:
        return
    interval = config.SCAN_INTERVAL_HOURS * 3600
    if time.time() - db.last_scan_time() < interval:
        return
    with _scan_lock:
        if _scan_running:
            return
        _scan_running = True

    def _run():
        global _scan_running
        try:
            log.info("Auto-scan triggered (interval: %dh)", config.SCAN_INTERVAL_HOURS)
            _fresh_scan()
        except Exception as e:
            log.error("Auto-scan failed: %s", e)
        finally:
            _scan_running = False

    threading.Thread(target=_run, daemon=True, name="auto-scan").start()


def _maybe_purge_trash():
    global _last_purge_check
    if not config.TRASH_PURGE_DAYS:
        return
    if time.time() - _last_purge_check < 3600:
        return
    _last_purge_check = time.time()
    try:
        n = trash_mod.purge_old_trash(config.TRASH_PURGE_DAYS)
        if n:
            log.info("Auto-purge: removed %d item(s) from trash (>%dd old)",
                     n, config.TRASH_PURGE_DAYS)
    except Exception as e:
        log.warning("Auto-purge failed: %s", e)


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
    db.record_scan(len(result), sum(o["size"] for o in result))

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
    _ensure_worker()
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
    _ensure_worker()
    job_id = db.enqueue_job("restore", targets)
    return jsonify({"job_id": job_id, "queued": True, "count": len(targets)})


@app.route("/api/trash/delete", methods=["POST"])
def api_trash_delete():
    data = request.get_json(silent=True) or {}
    paths = data.get("paths") or ([data["path"]] if data.get("path") else None)
    items = trash_mod.list_trash()
    targets = paths if paths else [i["trash_path"] for i in items]
    _ensure_worker()
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


@app.route("/api/jobs/<job_id>/cancel", methods=["POST"])
def api_job_cancel(job_id):
    db.cancel_job(job_id)
    return jsonify({"ok": True})


@app.route("/api/jobs/cancel", methods=["POST"])
def api_jobs_cancel_all():
    db.cancel_all_pending_jobs()
    return jsonify({"ok": True})


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


@app.route("/api/stats")
def api_stats():
    orphans = db.get_cached_orphans()
    return jsonify({
        "orphan_count": len(orphans),
        "orphan_size": sum(o["size"] for o in orphans),
        "trash_size": sum(i["size"] for i in trash_mod.list_trash()),
        "scan_history": db.get_scan_history(days=30),
        "cleanup_history": db.get_cleanup_history(days=30),
    })
