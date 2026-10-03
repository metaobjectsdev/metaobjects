"""Cross-port fmt conformance corpus (#304) — fixtures/fmt-conformance/.

See that directory's README.md for the fixture format. Mirrors the TS
reference (fmt-conformance.test.ts) and the C#/Java ports exactly; a
mismatch here is a bug in THIS port's formatter or serializer, never in the
fixture.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.core_types import core_providers
from metaobjects.fmt import format_file
from metaobjects.provider import compose_registry


def _corpus_root() -> Path:
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        candidate = parent / "fixtures" / "fmt-conformance"
        if candidate.is_dir():
            return candidate
    raise RuntimeError("could not locate fixtures/fmt-conformance from " + str(here))


CORPUS = _corpus_root()
FIXTURES = sorted(p.name for p in CORPUS.iterdir() if p.is_dir())


def test_found_fixtures() -> None:
    assert FIXTURES, "fixtures/fmt-conformance/ discovered no fixture directories"


@pytest.mark.parametrize("name", FIXTURES)
def test_fixture(name: str) -> None:
    fixture_dir = CORPUS / name
    content = (fixture_dir / "input.json").read_text(encoding="utf-8")
    registry = compose_registry(list(core_providers))

    result = format_file(content, registry, "input.json")

    expected_path = fixture_dir / "expected.json"
    expected_skip_path = fixture_dir / "expected-skip.json"

    if expected_path.exists():
        assert result.ok, result.message
        assert result.text == expected_path.read_text(encoding="utf-8")
    else:
        assert not result.ok, "expected a skip, but formatting succeeded"
        skip = json.loads(expected_skip_path.read_text(encoding="utf-8"))
        assert result.overlay == (skip["reason"] == "overlay")
