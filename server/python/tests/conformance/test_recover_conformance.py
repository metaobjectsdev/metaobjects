"""Cross-language recover-conformance corpus runner — FR-010 correctness gate.

Each fixture dir under ``fixtures/recover-conformance/`` holds:

- ``schema.json``   ``{ "format": "JSON"|"XML", "rootName": "...", "fields": [...] }``
- ``input.txt``     the raw (possibly dirty) LLM output
- ``expected.json`` ``{ "empty": bool, "states": {field: FieldRecovery}, "data": {field: value} }``

All 10 cases must pass. The corpus is the oracle — do not weaken assertions.
1:1 port of ``RecoverConformanceTest.java`` / ``RecoverConformanceTests.cs``.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from metaobjects.render.recover import (
    FieldKind,
    FieldSpec,
    Format,
    RecoverSchema,
    recover,
)


def _find_corpus() -> Path:
    p = Path(__file__).resolve()
    while p != p.parent:
        candidate = p / "fixtures" / "recover-conformance"
        if candidate.is_dir():
            return candidate
        p = p.parent
    raise RuntimeError("fixtures/recover-conformance not found walking up from tests/")


_CORPUS = _find_corpus()

_FORMATS = {"JSON": Format.JSON, "XML": Format.XML}
_KINDS = {
    "STRING": FieldKind.STRING,
    "INT": FieldKind.INT,
    "LONG": FieldKind.LONG,
    "DOUBLE": FieldKind.DOUBLE,
    "BOOLEAN": FieldKind.BOOLEAN,
    "ENUM": FieldKind.ENUM,
    "OBJECT": FieldKind.OBJECT,
}


def _cases() -> list[str]:
    return sorted(
        d.name for d in _CORPUS.iterdir() if (d / "schema.json").is_file()
    )


_NORMALIZE_MODES = {"none", "collapse", "strip"}


def _parse_normalize(s: object) -> str:
    """FR-011: parse the @normalize mode string; absent → the global default "strip"."""
    if s is None:
        return "strip"
    mode = str(s)
    assert mode in _NORMALIZE_MODES, f"unknown normalize mode: {mode!r}"
    return mode


def _parse_field(f: dict[str, object]) -> FieldSpec:
    name = str(f["name"])
    kind = _KINDS[str(f["kind"])]
    required = bool(f.get("required", False))

    if kind == FieldKind.ENUM:
        values_raw = f.get("enumValues")
        values = [str(v) for v in values_raw] if isinstance(values_raw, list) else None
        aliases_raw = f.get("enumAlias")
        aliases = (
            {str(k): str(v) for k, v in aliases_raw.items()}
            if isinstance(aliases_raw, dict)
            else {}
        )
        # FR-011: optional coerceDefault / normalize / default keys.
        coerce_default = str(f["coerceDefault"]) if "coerceDefault" in f else None
        normalize = _parse_normalize(f.get("normalize"))
        default_value = str(f["default"]) if "default" in f else None
        return FieldSpec.enum_field(
            name, required, values, aliases, coerce_default, normalize, default_value
        )

    if kind == FieldKind.OBJECT:
        array = bool(f.get("array", False))
        nested: RecoverSchema | None = None
        nested_raw = f.get("fields")
        if isinstance(nested_raw, list):
            child_specs = [_parse_field(nf) for nf in nested_raw]  # type: ignore[arg-type]
            nested = RecoverSchema(Format.JSON, name, child_specs)
        return FieldSpec.object_(name, required, array, nested)

    if "min" in f or "max" in f:
        min_v = float(f["min"]) if "min" in f else None  # type: ignore[arg-type]
        max_v = float(f["max"]) if "max" in f else None  # type: ignore[arg-type]
        return FieldSpec.range_(name, kind, required, min_v, max_v)

    return FieldSpec.scalar(name, kind, required)


def _parse_schema(node: dict[str, object]) -> RecoverSchema:
    fmt = _FORMATS[str(node["format"])]
    root_name = str(node["rootName"])
    fields_raw = node["fields"]
    assert isinstance(fields_raw, list)
    fields = [_parse_field(f) for f in fields_raw]
    return RecoverSchema(fmt, root_name, fields)


@pytest.mark.parametrize("case_name", _cases())
def test_classification_and_canonical_value_match(case_name: str) -> None:
    case_dir = _CORPUS / case_name

    schema = _parse_schema(json.loads((case_dir / "schema.json").read_text()))
    text = (case_dir / "input.txt").read_text()
    expected = json.loads((case_dir / "expected.json").read_text())

    outcome = recover(text, schema)

    # empty flag
    assert outcome.report.is_empty() == bool(expected["empty"]), (
        f"{case_name}: empty flag mismatch"
    )

    # per-field states (value + exhaustive key-set)
    actual_states = {k: v.value for k, v in outcome.report.states().items()}
    expected_states = {str(k): str(v) for k, v in expected["states"].items()}
    assert actual_states == expected_states, f"{case_name}: states mismatch"

    # per-field data (canonical value + exhaustive key-set)
    expected_data = expected["data"]
    assert set(outcome.data.keys()) == set(expected_data.keys()), (
        f"{case_name}: data key-set mismatch"
    )
    for field, exp in expected_data.items():
        act = outcome.data[field]
        if isinstance(exp, bool):
            assert act == exp, f"{case_name} data[{field}]: expected {exp} got {act}"
        elif isinstance(exp, (int, float)):
            assert isinstance(act, (int, float)) and not isinstance(act, bool), (
                f"{case_name} data[{field}]: expected number got {act!r}"
            )
            assert math.isclose(float(exp), float(act), abs_tol=1e-9), (
                f"{case_name} data[{field}]: expected {exp} got {act}"
            )
        elif isinstance(exp, dict):
            # FR-011: object expected values in the corpus are deliberate PLACEHOLDERS
            # ({}) — the real assertion lives in the per-field states (e.g. meta.score).
            # Assert only structural correspondence (map ↔ object).
            assert isinstance(act, dict), (
                f"{case_name} data[{field}]: expected an object got {act!r}"
            )
        elif isinstance(exp, list):
            # FR-011: array-of-objects expected values are placeholders ([{},…]); assert
            # only structural correspondence (list ↔ array), states carry the real check.
            assert isinstance(act, list), (
                f"{case_name} data[{field}]: expected an array got {act!r}"
            )
        else:
            assert str(act) == str(exp), (
                f"{case_name} data[{field}]: expected {exp!r} got {act!r}"
            )
