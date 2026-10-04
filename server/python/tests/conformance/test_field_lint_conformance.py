"""Cross-port field-lint conformance corpus — fixtures/field-lint-conformance/.

See that directory's README.md for the fixture format. Every case is LOADED strict
first, so "this loads with no error today" is proven by the fixture, and only then
linted. Mirrors the TS reference (field-lint-conformance.test.ts) and the C#/Java
ports exactly; a mismatch here is a bug in THIS port's lint, never in the fixture.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects import MetaDataLoader
from metaobjects.field_lint import lint_duplicate_fields, lint_reference_fields


def _corpus_root() -> Path:
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        candidate = parent / "fixtures" / "field-lint-conformance"
        if candidate.is_dir():
            return candidate
    raise RuntimeError("could not locate fixtures/field-lint-conformance from " + str(here))


CORPUS = _corpus_root()
FIXTURES = sorted(p.name for p in CORPUS.iterdir() if p.is_dir())


def test_found_fixtures() -> None:
    assert FIXTURES, "fixtures/field-lint-conformance/ discovered no fixture directories"


@pytest.mark.parametrize("name", FIXTURES)
def test_fixture(name: str) -> None:
    input_dir = CORPUS / name / "input"
    expected = json.loads((CORPUS / name / "expected.json").read_text(encoding="utf-8"))

    result = MetaDataLoader.from_directory(str(input_dir), strict=True)
    assert [str(e) for e in result.errors] == []

    findings = [
        *lint_reference_fields(result.root),
        *lint_duplicate_fields(sorted(input_dir.iterdir())),
    ]
    actual = sorted((f.code, f.path, f.message) for f in findings)
    assert actual == sorted((f["code"], f["path"], f["message"]) for f in expected["findings"])
