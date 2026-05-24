bind = "0.0.0.0:5000"
workers = 1
timeout = 120


def post_fork(server, worker):
    """Start the job worker thread in the worker process, not the master."""
    import threading
    from app import _job_worker
    threading.Thread(target=_job_worker, daemon=True, name="job-worker").start()
