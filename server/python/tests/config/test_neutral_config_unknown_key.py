"""An unknown top-level key in ``.metaobjects/config.json`` (one a newer release added) is
ignored: the neutral subset reads only what it knows."""
from __future__ import annotations

import json
import warnings
from pathlib import Path

from metaobjects.config.neutral_config import read_neutral_config


def test_an_unknown_top_level_key_is_ignored(tmp_path: Path) -> None:
    (tmp_path / ".metaobjects").mkdir()
    (tmp_path / ".metaobjects" / "config.json").write_text(
        json.dumps({"schema_version": 1, "sources": [{"path": "m"}], "someFutureKey": {"x": 1}}),
        encoding="utf-8",
    )
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        cfg = read_neutral_config(tmp_path)
    assert cfg is not None
    assert cfg.sources == [{"path": "m"}]
