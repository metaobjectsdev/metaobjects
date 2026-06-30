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


def test_dbcolumntype_timestamptz_retired_on_timestamp_error() -> None:
    # ADR-0036 Wave 2: @dbColumnType:timestamp_with_tz is RETIRED — it is no longer
    # a recognized value, so even on field.timestamp it is now ERR_BAD_ATTR_VALUE
    # (unknown value). Timezone-awareness moved to @localTime (instant by default).
    codes, _ = _load(_entity(
        {"field.long": {"name": "id"}},
        {"field.timestamp": {"name": "at", "@dbColumnType": "timestamp_with_tz"}},
    ))
    assert codes == ["ERR_BAD_ATTR_VALUE"]


def test_local_time_attr_on_timestamp_ok() -> None:
    # ADR-0036 Wave 2: @localTime is a valid boolean opt-out on field.timestamp.
    codes, _ = _load(_entity(
        {"field.long": {"name": "id"}},
        {"field.timestamp": {"name": "at", "@localTime": True}},
    ))
    assert codes == []


# ---------------------------------------------------------------------------
# Plan 2b — illegal pairings + unknown value → ERR_BAD_ATTR_VALUE
# ---------------------------------------------------------------------------


def test_dbcolumntype_timestamptz_on_string_illegal() -> None:
    # ADR-0036 Wave 2: timestamp_with_tz is retired → unknown value on any subtype.
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


# ---------------------------------------------------------------------------
# Phase 1 — uuid_array / text_array are REMOVED from the closed set.
# Derive native text[]/uuid[] from field.string/field.uuid + isArray instead.
# ---------------------------------------------------------------------------


def test_dbcolumntype_uuid_array_rejected() -> None:
    # uuid_array is no longer a valid @dbColumnType value (Phase 1 removal).
    # Derive native uuid[] from field.uuid isArray:true instead.
    codes, _ = _load(_entity(
        {"field.long": {"name": "id"}},
        {"field.string": {"name": "refs", "@dbColumnType": "uuid_array"}},
    ))
    assert codes == ["ERR_BAD_ATTR_VALUE"]


def test_dbcolumntype_text_array_rejected() -> None:
    # text_array is no longer a valid @dbColumnType value (Phase 1 removal).
    # Derive native text[] from field.string isArray:true instead.
    codes, _ = _load(_entity(
        {"field.long": {"name": "id"}},
        {"field.string": {"name": "tags", "@dbColumnType": "text_array"}},
    ))
    assert codes == ["ERR_BAD_ATTR_VALUE"]


def test_dbcolumntype_uuid_array_error_message_names_valid_set() -> None:
    # The error message should name only the surviving legal values in the
    # "allowed:" section — uuid_array must NOT appear there.
    from metaobjects import MetaDataLoader
    from metaobjects.core_types import core_provider
    import tempfile, os
    from pathlib import Path
    doc = _entity(
        {"field.long": {"name": "id"}},
        {"field.string": {"name": "refs", "@dbColumnType": "uuid_array"}},
    )
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "meta.test.json")
        Path(path).write_text(json.dumps(doc))
        result = MetaDataLoader.from_directory(tmpdir, providers=[core_provider])
        assert len(result.errors) == 1
        msg = result.errors[0].message
        # The "allowed:" section must list only the two surviving legal values
        # (ADR-0036 Wave 2 retired timestamp_with_tz → { uuid, jsonb }).
        allowed_idx = msg.index("allowed:")
        allowed_section = msg[allowed_idx:]
        assert "uuid" in allowed_section
        assert "jsonb" in allowed_section
        # timestamp_with_tz (retired), uuid_array, text_array must NOT appear.
        assert "timestamp_with_tz" not in allowed_section
        assert "uuid_array" not in allowed_section
        assert "text_array" not in allowed_section


# ---------------------------------------------------------------------------
# Phase 1 — field.uuid isArray → list[uuid.UUID] (already works via type_map;
# ensure the loader accepts it cleanly)
# ---------------------------------------------------------------------------


def test_field_uuid_is_array_loads_clean() -> None:
    codes, _ = _load(_entity(
        {"field.uuid": {"name": "ids", "isArray": True}},
    ))
    assert codes == []


def test_field_string_is_array_loads_clean() -> None:
    codes, _ = _load(_entity(
        {"field.long": {"name": "id"}},
        {"field.string": {"name": "tags", "isArray": True}},
    ))
    assert codes == []
