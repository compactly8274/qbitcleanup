bind = "0.0.0.0:5000"
workers = 1
timeout = 120


def post_fork(server, worker):
    """Start the job worker thread in the worker process, not the master."""
    from app import _ensure_worker
    _ensure_worker()
