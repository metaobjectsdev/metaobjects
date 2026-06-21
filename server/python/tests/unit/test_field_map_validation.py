"""Unit tests for the field.map value-type validation pass.

A ``field.map`` is an open-keyed map (``dict[str, V]`` / ``Record<string,V>``)
stored in a single jsonb column. Keys are always strings; the value type is set
by EXACTLY ONE of ``@valueType`` (a scalar value subtype) or ``@objectRef`` (a
value-object). This suite exercises the loader's ``_validate_field_map`` pass —
cross-port parity with the TS ``validateFieldMap``.
"""
from __future__ import annotations

import json

from metaobjects import MetaDataLoader
from metaobjects.errors import ErrorCode


def _load(*map_attrs: dict[str, object]):
    """Load a root with one VO (``Score``) and an entity carrying one field.map
    per supplied attr dict. Returns the LoadResult."""
    map_fields = [
        {"field.map": {"name": f"m{i}", **attrs}} for i, attrs in enumerate(map_attrs)
    ]
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.value": {
                        "name": "Score",
                        "children": [{"field.int": {"name": "points"}}],
                    }
                },
                {
                    "object.entity": {
                        "name": "Player",
                        "children": [
                            {"field.long": {"name": "id"}},
                            *map_fields,
                            {"identity.primary": {"@fields": "id"}},
                        ],
                    }
                },
            ],
        }
    }
    return MetaDataLoader.from_string(json.dumps(doc))


def _bad_attr_errors(result) -> list[str]:
    return [e.message for e in result.errors if e.code is ErrorCode.ERR_BAD_ATTR_VALUE]


def test_value_type_only_loads_clean() -> None:
    result = _load({"@valueType": "string"})
    assert not result.errors, [str(e) for e in result.errors]


def test_object_ref_only_loads_clean() -> None:
    result = _load({"@objectRef": "Score"})
    assert not result.errors, [str(e) for e in result.errors]


def test_neither_value_type_nor_object_ref_is_an_error() -> None:
    result = _load({})
    errs = _bad_attr_errors(result)
    assert errs, "field.map with neither @valueType nor @objectRef must error"
    assert any("neither is set" in m for m in errs)


def test_both_value_type_and_object_ref_is_an_error() -> None:
    result = _load({"@valueType": "string", "@objectRef": "Score"})
    errs = _bad_attr_errors(result)
    assert errs, "field.map with both @valueType and @objectRef must error"
    assert any("both are set" in m for m in errs)


def test_non_scalar_value_type_is_an_error() -> None:
    # "object" is a field subtype but NOT a scalar value subtype — a VO-valued
    # map must use @objectRef instead.
    result = _load({"@valueType": "object"})
    errs = _bad_attr_errors(result)
    assert errs, "field.map with a non-scalar @valueType must error"
    assert any("not a scalar value subtype" in m for m in errs)


def test_every_scalar_value_type_loads_clean() -> None:
    scalars = [
        "string", "int", "long", "double", "float", "decimal",
        "boolean", "date", "time", "timestamp", "uuid",
    ]
    result = _load(*({"@valueType": s} for s in scalars))
    assert not result.errors, [str(e) for e in result.errors]
