"""R6 Plan 2a/2b — field.uuid logical subtype + @dbColumnType physical attribute.

TDD: loader recognition + own-only pairing validation (ERR_BAD_ATTR_VALUE) and
the metadata→schema SqlType routing. Mirrors the field.enum @values precedent and
the cross-port C#/Java/TS behavior.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from metaobjects import MetaDataLoader
from metaobjects.core_types import core_provider
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.persistence.db import db_constants as dbc
from metaobjects.migrate.expected_schema import _subtype_to_sql_type
from metaobjects.migrate.sql_type import Text, Timestamp, Uuid, Json
from metaobjects.serializer_json import canonical_serialize
from metaobjects.shared.base_types import TYPE_FIELD


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


def _field(sub_type: str, db_col_type: str | None = None) -> MetaField:
    f = MetaField(TYPE_FIELD, sub_type, "x")
    if db_col_type is not None:
        f.set_attr(dbc.FIELD_ATTR_DB_COLUMN_TYPE, db_col_type)
    return f


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


def test_dbcolumntype_unknown_value_rejected() -> None:
    # An unrecognized value is rejected (closed set). The attr-schema allowed_values
    # check fires too — at least one ERR_BAD_ATTR_VALUE is present.
    codes, _ = _load(_entity(
        {"field.long": {"name": "id"}},
        {"field.string": {"name": "x", "@dbColumnType": "tsvector"}},
    ))
    assert "ERR_BAD_ATTR_VALUE" in codes


# ---------------------------------------------------------------------------
# Schema routing — Plan 2a + Plan 2b
# ---------------------------------------------------------------------------


def test_schema_uuid_subtype_maps_to_uuid() -> None:
    assert isinstance(_subtype_to_sql_type(_field(fc.FIELD_SUBTYPE_UUID)), Uuid)


def test_schema_dbcolumntype_overrides_subtype_default() -> None:
    # @dbColumnType:uuid on a string → Uuid (not Text).
    assert isinstance(
        _subtype_to_sql_type(_field(fc.FIELD_SUBTYPE_STRING, dbc.DB_COLUMN_TYPE_UUID)),
        Uuid,
    )
    # @dbColumnType:jsonb on a string → Json.
    assert isinstance(
        _subtype_to_sql_type(_field(fc.FIELD_SUBTYPE_STRING, dbc.DB_COLUMN_TYPE_JSONB)),
        Json,
    )
    # @dbColumnType:timestamp_with_tz on a timestamp → Timestamp(with_timezone=True).
    ts = _subtype_to_sql_type(_field(fc.FIELD_SUBTYPE_TIMESTAMP, dbc.DB_COLUMN_TYPE_TIMESTAMP_TZ))
    assert isinstance(ts, Timestamp) and ts.with_timezone is True


def test_schema_plain_string_is_text() -> None:
    # No @dbColumnType → subtype default (sanity that the override is opt-in).
    assert isinstance(_subtype_to_sql_type(_field(fc.FIELD_SUBTYPE_STRING)), Text)
