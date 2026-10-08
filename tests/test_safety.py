import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
for mod in ("config", "qbit", "scanner", "trash", "db"):
    sys.modules[mod] = MagicMock()

import safety


def test_is_cross_seed_path():
    assert safety.is_cross_seed_path("/downloads/cross-seed/staging/foo")
    assert safety.is_cross_seed_path("/downloads/.cross-seed")
    assert safety.is_cross_seed_path("/downloads/some.xseed.dir")
    assert not safety.is_cross_seed_path("/downloads/complete/movies/Foo")


def test_is_hardlinked(tmp_path):
    # Two hardlinks to the same file
    a = str(tmp_path / "a.txt")
    b = str(tmp_path / "b.txt")
    Path(a).write_text("hello")
    os.link(a, b)
    assert safety.is_hardlinked(a)

    # Single file
    c = str(tmp_path / "c.txt")
    Path(c).write_text("world")
    assert not safety.is_hardlinked(c)


def test_has_hardlink_descendant(tmp_path):
    a = str(tmp_path / "a.txt")
    b = str(tmp_path / "b.txt")
    Path(a).write_text("hello")
    os.link(a, b)
    assert safety.has_hardlink_descendant(str(tmp_path))

    c = tmp_path / "sub"
    c.mkdir()
    d = str(c / "d.txt")
    e = str(c / "e.txt")
    Path(d).write_text("x")
    os.link(d, e)
    assert safety.has_hardlink_descendant(str(tmp_path))


def test_is_safe_to_move():
    entry = {"path": "/downloads/orphan", "is_cross_seed": False, "is_hardlinked": False, "has_hardlink_descendant": False}
    assert safety.is_safe_to_move(entry, set()) == (True, "")

    entry["is_cross_seed"] = True
    assert safety.is_safe_to_move(entry, set()) == (False, "cross-seed / link-farm path")

    entry["is_cross_seed"] = False
    entry["is_hardlinked"] = True
    assert safety.is_safe_to_move(entry, set()) == (False, "hardlinked elsewhere")

    entry["is_hardlinked"] = False
    entry["has_hardlink_descendant"] = True
    assert safety.is_safe_to_move(entry, set()) == (False, "hardlinked elsewhere")


def test_is_safe_to_move_claimed():
    entry = {"path": "/downloads/foo", "is_cross_seed": False, "is_hardlinked": False, "has_hardlink_descendant": False}
    assert safety.is_safe_to_move(entry, {"/downloads/foo"}) == (False, "claimed by active qBittorrent torrent")
    assert safety.is_safe_to_move(entry, {"/downloads/foo/bar"}) == (False, "parent of active qBittorrent torrent content")
    assert safety.is_safe_to_move(entry, {"/downloads/foo2"}) == (True, "")
