"""R6 Plan 2a/2b — field.uuid logical subtype + @dbColumnType physical attribute.

TDD: loader recognition + own-only pairing validation (ERR_BAD_ATTR_VALUE).
Mirrors the field.enum @values precedent and the cross-port C#/Java/TS behavior.

Schema-routing (metadata→SqlType) is exercised TS-side now that schema
migrations are TS-only (ADR-0015); the Python migrate engine — including its
``_subtype_to_sql_type`` router — was removed. This file covers the LOADER
half (the surviving Python capability) only.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from metaobjects import MetaDataLoader
from metaobjects.core_types import core_provider
from metaobjects.serializer_json import canonical_serialize


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _load(doc: dict) -> tuple[list[str], str]:
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "meta.test.json")
        Path(path).write_text(json.dumps(doc))
        result = MetaDataLoader.from_directory(tmpdir, providers=[core_provider])
        codes = [e.code.name for e in result.errors]
        return codes, canonical_serialize(result.root)


def _entity(*fields: dict) -> dict:
    return {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Thing",
                        "children": [
                            *fields,
                            {"identity.primary": {"@fields": "id"}},
                        ],
                    }
                }
            ],
        }
    }


# ---------------------------------------------------------------------------
# Plan 2a — field.uuid loads as a bare scalar
# ---------------------------------------------------------------------------


def test_field_uuid_loads_clean() -> None:
    codes, _ = _load(_entity({"field.uuid": {"name": "id"}}))
    assert codes == []


def test_field_uuid_no_value_validation() -> None:
    # A bare scalar: no required attrs, no value validation regardless of content.
    codes, _ = _load(_entity({"field.uuid": {"name": "id", "@required": True}}))
    assert codes == []


# ---------------------------------------------------------------------------
# Plan 2b — @dbColumnType legal pairings load clean
# ---------------------------------------------------------------------------


def test_dbcolumntype_uuid_on_string_ok() -> None:
    codes, _ = _load(_entity(
        {"field.long": {"name": "id"}},
        {"field.string": {"name": "ext", "@dbColumnType": "uuid"}},
    ))
    assert codes == []


def test_dbcolumntype_jsonb_on_string_ok() -> None:
    codes, _ = _load(_entity(
        {"field.long": {"name": "id"}},
        {"field.string": {"name": "payload", "@dbColumnType": "jsonb"}},
    ))
    assert codes == []


def test_dbcolumntype_timestamptz_on_timestamp_ok() -> None:
    codes, _ = _load(_entity(
        {"field.long": {"name": "id"}},
        {"field.timestamp": {"name": "at", "@dbColumnType": "timestamp_with_tz"}},
    ))
    assert codes == []


# ---------------------------------------------------------------------------
# Plan 2b — illegal pairings + unknown value → ERR_BAD_ATTR_VALUE
# ---------------------------------------------------------------------------


def test_dbcolumntype_timestamptz_on_string_illegal() -> None:
    codes, _ = _load(_entity(
        {"field.long": {"name": "id"}},
        {"field.string": {"name": "at", "@dbColumnType": "timestamp_with_tz"}},
    ))
    assert codes == ["ERR_BAD_ATTR_VALUE"]


def test_dbcolumntype_uuid_on_timestamp_illegal() -> None:
    codes, _ = _load(_entity(
        {"field.long": {"name": "id"}},
        {"field.timestamp": {"name": "at", "@dbColumnType": "uuid"}},
    ))
    assert codes == ["ERR_BAD_ATTR_VALUE"]


def test_dbcolumntype_uuid_on_uuid_field_illegal() -> None:
    # A physical override on the LOGICAL uuid type is an error: @dbColumnType:uuid
    # requires field.string (the closed pairing table maps uuid -> field.string).
    # Pins the cross-port intent that uuid is logical-only on field.uuid.
    codes, _ = _load(_entity(
        {"field.long": {"name": "id"}},
        {"field.uuid": {"name": "ref", "@dbColumnType": "uuid"}},
    ))
    assert codes == ["ERR_BAD_ATTR_VALUE"]


def test_dbcolumntype_unknown_value_rejected() -> None:
    # An unrecognized value is rejected (closed set). @dbColumnType is a bare string
    # attr (NO allowed_values), so ONLY the _validate_db_column_type pass enforces the
    # closed set — exactly ONE ERR_BAD_ATTR_VALUE fires, matching TS/Java/C# (no
    # duplicate from a redundant attr-schema allowed_values check).
    codes, _ = _load(_entity(
        {"field.long": {"name": "id"}},
        {"field.string": {"name": "x", "@dbColumnType": "tsvector"}},
    ))
    assert codes == ["ERR_BAD_ATTR_VALUE"]
