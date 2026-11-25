"""Runs the shared reference-source corpus against this port.

Reads `fixtures/reference-source-conformance/cases.json` - the single committed source of
truth. Each case materializes `tree` + `config`, loads the project through the collection
ladder, and compares the exhaustive reference-node set (`expectReference`) or the load
error code (`expectLoadError`).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.cli import _load_collection_result
from metaobjects.config.source_resolver import resolve_collection_full
from metaobjects.errors import ParseError

_CORPUS = (
    Path(__file__).resolve().parents[4]
    / "fixtures"
    / "reference-source-conformance"
    / "cases.json"
)
_CASES = json.loads(_CORPUS.read_text())["cases"]


def test_corpus_is_non_empty() -> None:
    assert len(_CASES) > 0


def _materialize(case: dict, root: Path) -> None:
    for rel, content in case["tree"].items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    d = root / ".metaobjects"
    d.mkdir(parents=True, exist_ok=True)
    (d / "config.json").write_text(json.dumps(case["config"]))


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_reference_source_conformance(case: dict, tmp_path: Path) -> None:
    _materialize(case, tmp_path)
    collection = resolve_collection_full(tmp_path)

    if "expectLoadError" in case:
        expected = case["expectLoadError"]
        try:
            result = _load_collection_result(collection)
        except ParseError as e:
            assert e.code.value == expected
            return
        assert expected in {str(getattr(e.code, "value", e.code)) for e in result.errors}
        return

    result = _load_collection_result(collection)
    assert not result.errors
    assert sorted(result.root.reference_nodes) == sorted(case.get("expectReference", []))
