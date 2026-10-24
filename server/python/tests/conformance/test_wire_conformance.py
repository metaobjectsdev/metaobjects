"""ADR-0019 Amendment 2 cross-port conformance: ``fixtures/wire-conformance/config-blocks.json``.

Every port parses each case's ``wire`` block with its OWN config reader
(``metaobjects.config.neutral_config``) and must resolve ``decimals`` and ``nullMembers`` to
the recorded values; every ``invalid`` block must be refused when the config is read.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.config.neutral_config import read_neutral_config
from metaobjects.errors import ErrorCode, ParseError

REPO = Path(__file__).parents[4]
_SPEC = json.loads((REPO / "fixtures" / "wire-conformance" / "config-blocks.json").read_text())
_CASES: list[dict[str, object]] = _SPEC["cases"]
_INVALID: list[dict[str, object]] = _SPEC["invalid"]


def _project_with(tmp_path: Path, wire_block: object) -> Path:
    """A project dir whose ``.metaobjects/config.json`` declares *wire_block* (``None`` omits the key)."""
    raw: dict[str, object] = {"schema_version": 1}
    if wire_block is not None:
        raw["wire"] = wire_block
    dot = tmp_path / ".metaobjects"
    dot.mkdir(parents=True, exist_ok=True)
    (dot / "config.json").write_text(json.dumps(raw), encoding="utf-8")
    return tmp_path


@pytest.mark.parametrize("case", _CASES, ids=lambda c: c["name"])
def test_wire_block_resolves(case: dict[str, object], tmp_path: Path) -> None:
    cfg = read_neutral_config(_project_with(tmp_path, case["wire"]))
    assert cfg is not None
    assert cfg.wire.decimals == case["decimals"]
    assert cfg.wire.null_members == case["nullMembers"]


@pytest.mark.parametrize("case", _INVALID, ids=lambda c: c["name"])
def test_invalid_wire_block_is_refused(case: dict[str, object], tmp_path: Path) -> None:
    with pytest.raises(ParseError) as raised:
        read_neutral_config(_project_with(tmp_path, case["wire"]))
    assert raised.value.code == ErrorCode.ERR_COLLECTION_NOT_FOUND
    assert "wire" in str(raised.value)


def test_the_corpora_pin_the_portable_form() -> None:
    for corpus in ("api-contract-conformance", "persistence-conformance"):
        cfg = read_neutral_config(REPO / "fixtures" / corpus)
        assert cfg is not None
        assert (cfg.wire.decimals, cfg.wire.null_members) == ("string", "omit"), corpus
