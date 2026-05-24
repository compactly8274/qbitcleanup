import os

QBIT_HOST = os.environ.get("QBIT_HOST", "http://localhost")
QBIT_PORT = int(os.environ.get("QBIT_PORT", 8080))
QBIT_API_KEY = os.environ.get("QBIT_API_KEY", "").strip()
# Fallback for qBittorrent < 5.0 which does not support API keys
QBIT_USERNAME = os.environ.get("QBIT_USERNAME", "")
QBIT_PASSWORD = os.environ.get("QBIT_PASSWORD", "")
DOWNLOADS_DIR = os.environ.get("DOWNLOADS_DIR", "/downloads")
TRASH_DIR = os.environ.get("TRASH_DIR", "/downloads/.qbit-trash")
DB_PATH = os.environ.get("DB_PATH", "/downloads/.qbitcleanup.db")
SCAN_CACHE_TTL = int(os.environ.get("SCAN_CACHE_TTL", 604800))   # 1 week
MIN_ORPHAN_AGE_DAYS = int(os.environ.get("MIN_ORPHAN_AGE_DAYS", 0))  # 0 = no minimum
AUTO_TRASH_DAYS = int(os.environ.get("AUTO_TRASH_DAYS", 0))           # 0 = disabled
WEBHOOK_URL = os.environ.get("WEBHOOK_URL", "").strip()
