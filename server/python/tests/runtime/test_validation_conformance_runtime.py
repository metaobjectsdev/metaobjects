"""validation-conformance RUN-TIME runner (Python port).

The sibling ``tests/codegen/test_validation_conformance.py`` gates the GENERATED Pydantic
model. This one runs the same corpus through ``run_validators`` — the metadata-driven
run-time runner — and asserts the exact failure list pinned in ``runtime-errors.json``.
The TS ``runValidators`` runner asserts the same file, which is what keeps the two
run-time runners identical in structure and message text and not merely in verdict.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import metaobjects.core_types  # noqa: F401  — side effect: registers core types
from metaobjects import MetaDataLoader
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.runtime import run_validators

# tests/runtime/ -> server/python -> server -> <repo-root>
_CORPUS = Path(__file__).resolve().parents[4] / "fixtures" / "validation-conformance"
_DEFAULT_ENTITY = "Account"
_CASES = json.loads((_CORPUS / "cases.json").read_text())["cases"]
_EXPECTED_ERRORS = json.loads((_CORPUS / "runtime-errors.json").read_text())["errors"]


@pytest.fixture(scope="module")
def entities() -> dict[str, MetaObject]:
    result = MetaDataLoader.from_string((_CORPUS / "meta.json").read_text())
    assert not result.errors, [str(e) for e in result.errors]
    return {c.name: c for c in result.root.children() if isinstance(c, MetaObject)}


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_case(case: dict, entities: dict[str, MetaObject]) -> None:
    result = run_validators(entities[case.get("entity", _DEFAULT_ENTITY)], case["payload"])
    assert result.ok is case["expectValid"], result
    if not result.ok:
        assert [e.to_dict() for e in result.errors] == _EXPECTED_ERRORS.get(case["name"], [])


def test_runtime_errors_pins_exactly_the_rejected_cases() -> None:
    rejected = sorted(c["name"] for c in _CASES if not c["expectValid"])
    assert sorted(_EXPECTED_ERRORS) == rejected
