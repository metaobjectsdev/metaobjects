import json
import pytest
from pathlib import Path

from metaobjects.config.neutral_config import read_neutral_config
from metaobjects.errors import ParseError


def _write_config(root: Path, payload: object) -> None:
    d = root / ".metaobjects"
    d.mkdir(parents=True, exist_ok=True)
    (d / "config.json").write_text(json.dumps(payload))


def test_absent_config_returns_none(tmp_path: Path) -> None:
    assert read_neutral_config(tmp_path) is None


def test_reads_sources(tmp_path: Path) -> None:
    _write_config(tmp_path, {"schema_version": 1, "sources": [{"path": "model"}]})
    cfg = read_neutral_config(tmp_path)
    assert cfg is not None
    assert cfg.sources == [{"path": "model"}]


def test_unknown_top_level_keys_are_ignored(tmp_path: Path) -> None:
    # The file carries TypeScript-owned keys this port must not model.
    _write_config(
        tmp_path,
        {
            "schema_version": 1,
            "sources": [{"path": "model"}],
            "pending_in_git": True,
            "confidence_thresholds": {"pending_promote": 0.8},
            "extract": {"metaignore": ".metaignore"},
            "migrate": {"dialect": "postgres"},
        },
    )
    cfg = read_neutral_config(tmp_path)
    assert cfg is not None
    assert cfg.sources == [{"path": "model"}]


def test_absent_sources_key_yields_empty_list(tmp_path: Path) -> None:
    _write_config(tmp_path, {"schema_version": 1})
    cfg = read_neutral_config(tmp_path)
    assert cfg is not None
    assert cfg.sources == []


def test_malformed_json_raises_not_none(tmp_path: Path) -> None:
    d = tmp_path / ".metaobjects"
    d.mkdir(parents=True)
    (d / "config.json").write_text("{ not json")
    # A file that EXISTS but cannot be read must never look like no config at all.
    with pytest.raises(ParseError):
        read_neutral_config(tmp_path)


def test_wrong_schema_version_raises(tmp_path: Path) -> None:
    _write_config(tmp_path, {"schema_version": 2, "sources": []})
    with pytest.raises(ParseError):
        read_neutral_config(tmp_path)
