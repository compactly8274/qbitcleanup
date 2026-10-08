import sys
from pathlib import Path
from unittest.mock import MagicMock

# Make repo root importable and stub out heavy/IO modules before importing app.py.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
for mod in ("config", "qbit", "scanner", "trash", "db"):
    sys.modules[mod] = MagicMock()

import app


def test_filter_active_paths_skips_claimed_and_parents():
    claimed = {
        "/downloads/foo",
        "/downloads/bar/sub",
        "/downloads/bar/sub/file.mkv",
    }
    paths = [
        "/downloads/foo",          # exact active
        "/downloads/bar",          # parent of active
        "/downloads/bar/sub",      # exact active
        "/downloads/baz",          # truly orphan
        "/downloads/qux/dir",      # orphan dir
    ]
    safe, conflicts = app._filter_active_paths(paths, claimed)
    assert safe == ["/downloads/baz", "/downloads/qux/dir"]
    assert conflicts == ["/downloads/foo", "/downloads/bar", "/downloads/bar/sub"]


def test_filter_active_paths_empty_claimed():
    safe, conflicts = app._filter_active_paths(["/downloads/a", "/downloads/b"], set())
    assert safe == ["/downloads/a", "/downloads/b"]
    assert conflicts == []


def test_filter_active_paths_trailing_slash_normalization():
    claimed = {"/downloads/foo/"}
    safe, conflicts = app._filter_active_paths(["/downloads/foo", "/downloads/bar"], claimed)
    assert safe == ["/downloads/bar"]
    assert conflicts == ["/downloads/foo"]
