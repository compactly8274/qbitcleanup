import os

QBIT_HOST = os.environ.get("QBIT_HOST", "http://localhost")
QBIT_PORT = int(os.environ.get("QBIT_PORT", 8080))
QBIT_USERNAME = os.environ.get("QBIT_USERNAME", "admin")
QBIT_PASSWORD = os.environ.get("QBIT_PASSWORD", "adminadmin")
DOWNLOADS_DIR = os.environ.get("DOWNLOADS_DIR", "/downloads")
TRASH_DIR = os.environ.get("TRASH_DIR", "/downloads/.qbit-trash")

