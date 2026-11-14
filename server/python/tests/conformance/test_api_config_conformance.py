"""Cross-port conformance: ``fixtures/api-contract-conformance/api-settings/config-blocks.json``.

Every port parses each case's ``api`` block with its OWN config reader
(``metaobjects.config.neutral_config``) and must resolve ``pagination`` and ``unknownFields`` to the
recorded values; every ``invalid`` block must be refused when the config is read.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.api_settings import ApiPagination
from metaobjects.config.neutral_config import read_neutral_config
from metaobjects.errors import ParseError

REPO = Path(__file__).parents[4]
_SPEC = json.loads(
    (REPO / "fixtures" / "api-contract-conformance" / "api-settings" / "config-blocks.json").read_text()
)
_CASES: list[dict[str, object]] = _SPEC["cases"]
_INVALID: list[dict[str, object]] = _SPEC["invalid"]


def _project_with(tmp_path: Path, api_block: object) -> Path:
    """A project dir whose ``.metaobjects/config.json`` declares *api_block* (``None`` omits the key)."""
    raw: dict[str, object] = {"schema_version": 1}
    if api_block is not None:
        raw["api"] = api_block
    dot = tmp_path / ".metaobjects"
    dot.mkdir(parents=True, exist_ok=True)
    (dot / "config.json").write_text(json.dumps(raw), encoding="utf-8")
    return tmp_path


@pytest.mark.parametrize("case", _CASES, ids=[str(c["name"]) for c in _CASES])
def test_a_valid_block_resolves_to_the_corpus_values(tmp_path: Path, case: dict[str, object]) -> None:
    cfg = read_neutral_config(_project_with(tmp_path, case["api"]))
    assert cfg is not None
    want = case["pagination"]
    if want is None:
        assert cfg.api.pagination is None
    else:
        assert isinstance(want, dict)
        assert cfg.api.pagination == ApiPagination(
            default_limit=want["defaultLimit"], max_limit=want["maxLimit"]
        )
    assert cfg.api.unknown_fields == case["unknownFields"]


@pytest.mark.parametrize("case", _INVALID, ids=[str(c["name"]) for c in _INVALID])
def test_an_invalid_block_is_refused_when_read(tmp_path: Path, case: dict[str, object]) -> None:
    with pytest.raises(ParseError):
        read_neutral_config(_project_with(tmp_path, case["api"]))
