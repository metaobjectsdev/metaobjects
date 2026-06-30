"""Phase 1 — _coerce_write_value for native-array columns.

When a field has isArray=True the ObjectManager write path must convert a
list of author strings to the native element type so pg8000 binds a native
PG array column (text[] / uuid[]).

  field.uuid  isArray=True: list[str] → list[uuid.UUID]
  field.string isArray=True: list[str] → list[str]  (passthrough — pg8000
      already binds a Python list[str] to text[])

This tests the internal helper _coerce_write_value directly (white-box).
No database is required.
"""
from __future__ import annotations

import uuid as _uuid

import metaobjects.core_types  # noqa: F401 — register attr classes
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.shared.base_types import TYPE_FIELD
from metaobjects.runtime.object_manager import _coerce_write_value  # type: ignore[attr-defined]


def _field(sub_type: str, *, is_array: bool = False) -> MetaField:
    f = MetaField(TYPE_FIELD, sub_type, "x")
    f.is_array = is_array
    return f


_UUID_STR_A = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
_UUID_STR_B = "b2c3d4e5-f6a7-8901-bcde-f12345678901"


class TestUuidArrayCoercion:
    """field.uuid isArray=True — list of strings must be converted to list[uuid.UUID]."""

    def test_list_of_strings_coerced_to_list_of_uuid_objects(self) -> None:
        field = _field(fc.FIELD_SUBTYPE_UUID, is_array=True)
        result = _coerce_write_value(field, [_UUID_STR_A, _UUID_STR_B])
        assert isinstance(result, list)
        assert all(isinstance(v, _uuid.UUID) for v in result)
        assert result[0] == _uuid.UUID(_UUID_STR_A)
        assert result[1] == _uuid.UUID(_UUID_STR_B)

    def test_list_already_containing_uuid_objects_passes_through(self) -> None:
        field = _field(fc.FIELD_SUBTYPE_UUID, is_array=True)
        uuids = [_uuid.UUID(_UUID_STR_A), _uuid.UUID(_UUID_STR_B)]
        result = _coerce_write_value(field, uuids)
        assert result == uuids

    def test_none_passthrough(self) -> None:
        field = _field(fc.FIELD_SUBTYPE_UUID, is_array=True)
        assert _coerce_write_value(field, None) is None

    def test_empty_list_passthrough(self) -> None:
        field = _field(fc.FIELD_SUBTYPE_UUID, is_array=True)
        result = _coerce_write_value(field, [])
        assert result == []

    def test_mixed_types_in_list_coerced(self) -> None:
        # A mix of str and uuid.UUID — all coerced to uuid.UUID.
        field = _field(fc.FIELD_SUBTYPE_UUID, is_array=True)
        result = _coerce_write_value(field, [_UUID_STR_A, _uuid.UUID(_UUID_STR_B)])
        assert all(isinstance(v, _uuid.UUID) for v in result)


class TestStringArrayCoercion:
    """field.string isArray=True — list passes through (pg8000 binds list[str] to text[])."""

    def test_list_of_strings_passes_through(self) -> None:
        field = _field(fc.FIELD_SUBTYPE_STRING, is_array=True)
        tags = ["alpha", "beta", "gamma"]
        result = _coerce_write_value(field, tags)
        assert result == tags

    def test_none_passthrough(self) -> None:
        field = _field(fc.FIELD_SUBTYPE_STRING, is_array=True)
        assert _coerce_write_value(field, None) is None

    def test_empty_list_passthrough(self) -> None:
        field = _field(fc.FIELD_SUBTYPE_STRING, is_array=True)
        assert _coerce_write_value(field, []) == []
