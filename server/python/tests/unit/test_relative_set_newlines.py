"""The codegen drift gate must compare bytes: a CRLF file is not the LF file the generator wrote."""
from __future__ import annotations

from pathlib import Path

from metaobjects.cli import _relative_set


def test_relative_set_keeps_carriage_returns(tmp_path: Path) -> None:
    (tmp_path / "a.py").write_bytes(b"x = 1\r\ny = 2\r\n")
    assert _relative_set(tmp_path) == {"a.py": "x = 1\r\ny = 2\r\n"}
