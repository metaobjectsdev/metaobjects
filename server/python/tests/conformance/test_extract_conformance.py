"""Cross-language extract-conformance corpus runner — FR-010 correctness gate.

Each fixture dir under ``fixtures/extract-conformance/`` holds:

- ``schema.json``   ``{ "format": "JSON"|"XML", "rootName": "...", "fields": [...] }``
- ``input.txt``     the raw (possibly dirty) LLM output
- ``expected.json`` ``{ "empty": bool, "states": {field: FieldExtraction}, "data": {field: value} }``

All 22 cases must pass. The corpus is the oracle — do not weaken assertions.
1:1 port of ``ExtractConformanceTest.java`` / ``ExtractConformanceTests.cs``.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from metaobjects.render.extract import (
    ExtractOptions,
    FieldKind,
    FieldSpec,
    Format,
    ExtractSchema,
    extract,
)


def _find_corpus() -> Path:
    p = Path(__file__).resolve()
    while p != p.parent:
        candidate = p / "fixtures" / "extract-conformance"
        if candidate.is_dir():
            return candidate
        p = p.parent
    raise RuntimeError("fixtures/extract-conformance not found walking up from tests/")


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


def test_discovers_all_extract_conformance_cases() -> None:
    """FR-011: lock the corpus size so a deleted fixture fails CI rather than
    silently reducing coverage. Mirrors the TS / Java / C# count guards."""
    assert len(_cases()) == 31


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
        # Phase B (array-of-enum): kind ENUM + array true → per-element enum coercion.
        if bool(f.get("array", False)):
            return FieldSpec.enum_array(
                name, required, values, aliases, coerce_default, normalize, default_value
            )
        return FieldSpec.enum_field(
            name, required, values, aliases, coerce_default, normalize, default_value
        )

    if kind == FieldKind.OBJECT:
        array = bool(f.get("array", False))
        nested: ExtractSchema | None = None
        nested_raw = f.get("fields")
        if isinstance(nested_raw, list):
            child_specs = [_parse_field(nf) for nf in nested_raw]  # type: ignore[arg-type]
            nested = ExtractSchema(Format.JSON, name, child_specs)
        return FieldSpec.object_(name, required, array, nested)

    if "min" in f or "max" in f:
        min_v = float(f["min"]) if "min" in f else None  # type: ignore[arg-type]
        max_v = float(f["max"]) if "max" in f else None  # type: ignore[arg-type]
        return FieldSpec.range_(name, kind, required, min_v, max_v)

    # @xmlText: a scalar field that receives its element's text content (the #text sentinel).
    if bool(f.get("textContent", False)):
        return FieldSpec.text_content_field(name, kind, required)

    # Phase B (generalized @default): a scalar field may carry an absent-fill @default.
    default_value = str(f["default"]) if "default" in f else None
    return FieldSpec.scalar(name, kind, required, default_value)


def _flatten_leaves(prefix: str, value: object, out: dict[str, object]) -> None:
    """Flatten an assembled-data value into dotted leaf paths: dicts recurse by key
    (``prefix.key``), lists recurse by index (``prefix[i]``), and every terminal scalar is
    recorded. Mirrors the engine's per-field state enumeration so data leaves line up with
    state leaves (minus dropped/malformed leaves)."""
    if isinstance(value, dict):
        for k, v in value.items():
            key = str(k) if not prefix else f"{prefix}.{k}"
            _flatten_leaves(key, v, out)
    elif isinstance(value, list):
        for i, item in enumerate(value):
            _flatten_leaves(f"{prefix}[{i}]", item, out)
    else:
        out[prefix] = value


def _parse_schema(node: dict[str, object]) -> ExtractSchema:
    fmt = _FORMATS[str(node["format"])]
    root_name = str(node["rootName"])
    fields_raw = node["fields"]
    assert isinstance(fields_raw, list)
    fields = [_parse_field(f) for f in fields_raw]
    return ExtractSchema(fmt, root_name, fields)


@pytest.mark.parametrize("case_name", _cases())
def test_classification_and_canonical_value_match(case_name: str) -> None:
    case_dir = _CORPUS / case_name

    schema_node = json.loads((case_dir / "schema.json").read_text())
    schema = _parse_schema(schema_node)
    text = (case_dir / "input.txt").read_text()
    expected = json.loads((case_dir / "expected.json").read_text())

    # Optional per-fixture parse option: "rootless": true → the XML response has no wrapper
    # root element (the payload's fields ARE the top-level elements). Mirrors the Java/TS
    # runners. JSON fixtures ignore it.
    opts = ExtractOptions.defaults()
    if bool(schema_node.get("rootless", False)):
        opts = opts.with_rootless(True)

    outcome = extract(text, schema, opts)

    # empty flag
    assert outcome.report.is_empty() == bool(expected["empty"]), (
        f"{case_name}: empty flag mismatch"
    )

    # per-field states (value + exhaustive key-set)
    actual_states = {k: v.value for k, v in outcome.report.states().items()}
    expected_states = {str(k): str(v) for k, v in expected["states"].items()}
    assert actual_states == expected_states, f"{case_name}: states mismatch"

    # Data is compared as a flat DOTTED-LEAF map (mirroring states): nested objects and arrays
    # are flattened to leaf paths (meta.score, items[0].label, tags[0], …) and every leaf VALUE
    # is asserted — including scalar-array elements and nested-object leaves.
    actual_leaves: dict[str, object] = {}
    for key, val in outcome.data.items():
        _flatten_leaves(key, val, actual_leaves)

    expected_data = expected["data"]
    assert set(actual_leaves.keys()) == set(expected_data.keys()), (
        f"{case_name}: data leaf-set mismatch"
    )
    for path, exp in expected_data.items():
        act = actual_leaves[path]
        if isinstance(exp, bool):
            assert act == exp, f"{case_name} data[{path}]: expected {exp} got {act}"
        elif isinstance(exp, (int, float)):
            assert isinstance(act, (int, float)) and not isinstance(act, bool), (
                f"{case_name} data[{path}]: expected number got {act!r}"
            )
            assert math.isclose(float(exp), float(act), abs_tol=1e-9), (
                f"{case_name} data[{path}]: expected {exp} got {act}"
            )
        else:
            assert str(act) == str(exp), (
                f"{case_name} data[{path}]: expected {exp!r} got {act!r}"
            )
