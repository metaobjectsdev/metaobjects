"""field.enum's @intValueMap (int-backed-enum-values plan) — Python port.

Mirrors the TS/C#/Java conformance surface: an optional attr.intMap-shaped
@intValueMap ({member: int}) whose keys must exactly match @values and whose
values must be unique integers. Reuses ERR_BAD_ATTR_VALUE — no new error code.
"""
from __future__ import annotations

from metaobjects.errors import ErrorCode
from metaobjects.loader.meta_data_loader import MetaDataLoader
from metaobjects.loader.sources import InMemoryStringSource


def _model(extra: str) -> str:
    return f"""{{ "metadata.root": {{ "package": "acme", "children": [
      {{ "object.entity": {{ "name": "Order", "children": [
        {{ "field.long": {{ "name": "id" }} }},
        {{ "field.enum": {{ "name": "status", "@values": ["DRAFT","PUBLISHED","ARCHIVED"] {extra} }} }},
        {{ "identity.primary": {{ "name": "pk", "@fields": ["id"] }} }}
      ]}} }}
    ]}} }}"""


def _load(json_str: str):
    loader = MetaDataLoader()
    return loader.load([InMemoryStringSource(json_str, "test.json")])


def test_valid_intvaluemap_with_matching_keys_and_unique_ints_loads_clean():
    result = _load(_model(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9}'))
    assert result.errors == []


def test_no_intvaluemap_still_loads_clean_string_backed_default():
    result = _load(_model(""))
    assert result.errors == []


def test_missing_member_key_is_rejected():
    result = _load(_model(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5}'))
    assert len(result.errors) > 0
    assert result.errors[0].code == ErrorCode.ERR_BAD_ATTR_VALUE
    assert "ARCHIVED" in result.errors[0].message


def test_extra_key_not_in_values_is_rejected():
    result = _load(_model(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9, "RETRACTED": 12}'))
    assert len(result.errors) > 0
    assert result.errors[0].code == ErrorCode.ERR_BAD_ATTR_VALUE
    assert "RETRACTED" in result.errors[0].message


def test_non_integer_value_is_rejected():
    result = _load(_model(', "@intValueMap": {"DRAFT": "zero", "PUBLISHED": 5, "ARCHIVED": 9}'))
    assert len(result.errors) > 0
    assert result.errors[0].code == ErrorCode.ERR_BAD_ATTR_VALUE


def test_duplicate_int_value_across_members_is_rejected():
    result = _load(_model(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 0, "ARCHIVED": 9}'))
    assert len(result.errors) > 0
    assert result.errors[0].code == ErrorCode.ERR_BAD_ATTR_VALUE
    assert "DRAFT" in result.errors[0].message and "PUBLISHED" in result.errors[0].message


def test_value_outside_32bit_range_is_rejected():
    # Final-review fix: the eventual DB column for an int-backed enum is a
    # 32-bit Postgres/SQLite `integer` (design doc D5) — a value outside that
    # range can never actually be persisted, so it must be rejected at load
    # time. Mirrors Java's IntMapAttribute#setValueAsString bound check
    # (Python ints have no fixed width, so nothing else in this port would
    # otherwise catch this).
    result = _load(_model(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9999999999}'))
    assert len(result.errors) > 0
    assert result.errors[0].code == ErrorCode.ERR_BAD_ATTR_VALUE


# ---------------------------------------------------------------------------
# Regression: @intValueMap validation when @values is INHERITED via extends
# (bug — Rule 4 lived behind an `own_values is None: continue` early-return,
# so a concrete field.enum that inherits @values from an abstract parent but
# owns its own @intValueMap got that map skipped entirely).
# ---------------------------------------------------------------------------


def _model_inherited_values(extra: str) -> str:
    """An abstract field.enum owning @values, and a concrete field.enum on
    Order.status that `extends` it (inheriting @values) while owning its own
    @intValueMap directly.

    The abstract enum is nested inside an abstract object.entity, NOT declared at
    metadata-root: a root-level abstract enum is a SHARED enum (FR-019), and #246's
    int-backed twin forbids a consuming field from owning an @intValueMap against
    one. A non-root abstract super stays legal, so this is the shape that still
    exercises "own @intValueMap validated against INHERITED @values".
    """
    return f"""{{ "metadata.root": {{ "package": "acme", "children": [
      {{ "object.entity": {{ "name": "Container", "abstract": true, "children": [
        {{ "field.enum": {{ "name": "kind", "abstract": true, "@values": ["DRAFT","PUBLISHED","ARCHIVED"] }} }}
      ]}} }},
      {{ "object.entity": {{ "name": "Order", "children": [
        {{ "field.long": {{ "name": "id" }} }},
        {{ "field.enum": {{ "name": "status", "extends": "acme::Container.kind" {extra} }} }},
        {{ "identity.primary": {{ "name": "pk", "@fields": ["id"] }} }}
      ]}} }}
    ]}} }}"""


def test_intvaluemap_on_node_with_inherited_values_missing_key_is_rejected():
    # status.status has no own @values (inherited from abstract Status) but
    # owns its own @intValueMap missing the "ARCHIVED" key — must still be
    # validated against the EFFECTIVE (inherited) @values, not skipped.
    result = _load(
        _model_inherited_values(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5}')
    )
    assert len(result.errors) > 0
    assert result.errors[0].code == ErrorCode.ERR_BAD_ATTR_VALUE
    assert "ARCHIVED" in result.errors[0].message


def test_intvaluemap_on_node_with_inherited_values_extra_key_is_rejected():
    result = _load(
        _model_inherited_values(
            ', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9, "RETRACTED": 12}'
        )
    )
    assert len(result.errors) > 0
    assert result.errors[0].code == ErrorCode.ERR_BAD_ATTR_VALUE
    assert "RETRACTED" in result.errors[0].message


def test_intvaluemap_on_node_with_inherited_values_valid_map_loads_clean():
    # Positive-case sibling: a valid @intValueMap (keys exactly matching the
    # inherited @values, unique ints) must NOT be rejected — proving the fix
    # doesn't just make every inherited-@values node fail.
    result = _load(
        _model_inherited_values(
            ', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9}'
        )
    )
    assert result.errors == []


def _model_shared_enum(extra: str) -> str:
    """A ROOT-level abstract field.enum (a SHARED enum per FR-019) owning @values,
    and a concrete Order.status that `extends` it."""
    return f"""{{ "metadata.root": {{ "package": "acme", "children": [
      {{ "field.enum": {{ "name": "Status", "abstract": true, "@values": ["DRAFT","PUBLISHED","ARCHIVED"] }} }},
      {{ "object.entity": {{ "name": "Order", "children": [
        {{ "field.long": {{ "name": "id" }} }},
        {{ "field.enum": {{ "name": "status", "extends": "acme::Status" {extra} }} }},
        {{ "identity.primary": {{ "name": "pk", "@fields": ["id"] }} }}
      ]}} }}
    ]}} }}"""


def test_own_intvaluemap_against_shared_enum_is_rejected():
    # #246 int-backed twin: a shared enum is materialized ONCE as a single type, so
    # its integer backing belongs on the shared declaration. A consuming field that
    # owns an @intValueMap would give one logical type N storage encodings.
    result = _load(
        _model_shared_enum(
            ', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9}'
        )
    )
    codes = [e.code for e in result.errors]
    assert ErrorCode.ERR_ENUM_EXTENDS_VALUES_CONFLICT in codes


def test_intvaluemap_on_the_shared_declaration_itself_loads_clean():
    # The sanctioned shape: the shared declaration owns BOTH @values and the
    # integer backing; the consuming field inherits both and declares neither.
    result = _load(
        """{ "metadata.root": { "package": "acme", "children": [
          { "field.enum": { "name": "Status", "abstract": true,
            "@values": ["DRAFT","PUBLISHED","ARCHIVED"],
            "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9} } },
          { "object.entity": { "name": "Order", "children": [
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "status", "extends": "acme::Status" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
          ]} }
        ]} }"""
    )
    assert result.errors == []
