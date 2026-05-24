from flask import Flask, jsonify, request, render_template
import config
import qbit
import scanner
import trash as trash_mod

app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def api_status():
    status = qbit.get_status()
    orphan_count = 0
    trash_count = 0

    if status["connected"]:
        paths = qbit.get_torrent_paths()
        if paths is not None:
            orphans = scanner.scan_orphans(paths)
            if isinstance(orphans, list):
                orphan_count = len(orphans)

    trash_items = trash_mod.list_trash()
    trash_count = len(trash_items)

    return jsonify({
        "connected": status["connected"],
        "version": status["version"],
        "orphan_count": orphan_count,
        "trash_count": trash_count,
        "downloads_dir": config.DOWNLOADS_DIR,
        "trash_dir": config.TRASH_DIR,
    })


@app.route("/api/orphans")
def api_orphans():
    status = qbit.get_status()
    if not status["connected"]:
        return jsonify({"error": "qBittorrent is offline"}), 503

    paths = qbit.get_torrent_paths()
    if paths is None:
        return jsonify({"error": "Failed to fetch torrent list from qBittorrent"}), 502

    result = scanner.scan_orphans(paths)
    if isinstance(result, dict) and "error" in result:
        return jsonify(result), 500

    return jsonify(result)


@app.route("/api/orphans/move", methods=["POST"])
def api_orphans_move():
    data = request.get_json(silent=True) or {}
    path = data.get("path")

    status = qbit.get_status()
    if not status["connected"]:
        return jsonify({"error": "qBittorrent is offline"}), 503

    paths = qbit.get_torrent_paths()
    if paths is None:
        return jsonify({"error": "Failed to fetch torrent list"}), 502

    orphans = scanner.scan_orphans(paths)
    if isinstance(orphans, dict) and "error" in orphans:
        return jsonify(orphans), 500

    targets = [o["path"] for o in orphans] if path is None else [path]

    moved = []
    errors = []
    for t in targets:
        try:
            dest = trash_mod.move_to_trash(t)
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

    restored = []
    errors = []
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

    deleted = []
    errors = []
    for t in targets:
        try:
            trash_mod.delete(t)
            deleted.append(t)
        except Exception as e:
            errors.append({"path": t, "error": str(e)})

    return jsonify({"deleted": deleted, "errors": errors})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
