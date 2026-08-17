"""field.enum @intValueMap — Python ObjectManager persistence codec.

The metamodel layer ships the attribute; this pins the RUNTIME halves:
write encodes the member symbol to its declared int, read decodes it back.

The native/wire contract is unchanged in both directions — a caller always
passes and receives the member SYMBOL, exactly as for a string-backed enum
(design goal 2: int-backing is a persistence-layer-only concern). Only the
value handed to / received from the driver differs.
"""
from __future__ import annotations

import pytest

from metaobjects.loader.meta_data_loader import MetaDataLoader
from metaobjects.loader.sources import InMemoryStringSource
from metaobjects.runtime.object_manager import _coerce_write_value, _decode_read_value

INT_MAP = ', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9}'


def _field_of(json_str: str, entity_name: str, field_name: str):
    """Load a model and pull one field. MetaRoot has no find_object and
    MetaObject no field(name) — children()/fields() are the real accessors."""
    result = MetaDataLoader().load([InMemoryStringSource(json_str, "test.json")])
    assert result.errors == []
    entity = next(c for c in result.root.children() if c.name == entity_name)
    return next(f for f in entity.fields() if f.name == field_name)


def _status_field(extra: str):
    json_str = f"""{{ "metadata.root": {{ "package": "acme", "children": [
      {{ "object.entity": {{ "name": "Order", "children": [
        {{ "field.long": {{ "name": "id" }} }},
        {{ "field.enum": {{ "name": "status", "@values": ["DRAFT","PUBLISHED","ARCHIVED"] {extra} }} }},
        {{ "identity.primary": {{ "name": "pk", "@fields": ["id"] }} }}
      ]}} }}
    ]}} }}"""
    return _field_of(json_str, "Order", "status")


# --- write side -----------------------------------------------------------


@pytest.mark.parametrize("symbol,stored", [("DRAFT", 0), ("PUBLISHED", 5), ("ARCHIVED", 9)])
def test_int_backed_enum_write_encodes_symbol_to_declared_int(symbol, stored):
    assert _coerce_write_value(_status_field(INT_MAP), symbol) == stored


def test_int_backed_enum_write_encodes_zero_not_falsy_dropped():
    """DRAFT maps to 0 — a falsy int. Guards the `if not mapped` class of bug."""
    assert _coerce_write_value(_status_field(INT_MAP), "DRAFT") == 0


def test_string_backed_enum_write_is_unchanged():
    assert _coerce_write_value(_status_field(""), "PUBLISHED") == "PUBLISHED"


def test_none_stays_none_on_write():
    assert _coerce_write_value(_status_field(INT_MAP), None) is None


def test_unknown_symbol_on_write_is_left_alone_for_the_db_to_reject():
    """Not the codec's job to validate membership — the CHECK constraint is."""
    assert _coerce_write_value(_status_field(INT_MAP), "NOPE") == "NOPE"


# --- read side ------------------------------------------------------------


@pytest.mark.parametrize("stored,symbol", [(0, "DRAFT"), (5, "PUBLISHED"), (9, "ARCHIVED")])
def test_int_backed_enum_read_decodes_int_to_symbol(stored, symbol):
    assert _decode_read_value(_status_field(INT_MAP), stored) == symbol


def test_int_backed_enum_read_decodes_zero():
    assert _decode_read_value(_status_field(INT_MAP), 0) == "DRAFT"


def test_string_backed_enum_read_is_unchanged():
    assert _decode_read_value(_status_field(""), "PUBLISHED") == "PUBLISHED"


def test_none_stays_none_on_read():
    assert _decode_read_value(_status_field(INT_MAP), None) is None


def test_unmapped_int_on_read_raises():
    """A row holding an int outside the map is data the model says is impossible.

    Neither alternative is honest: returning the raw int hands the caller a
    "member" that is not one (C#, Kotlin and TypeScript type this as a CLOSED
    enum, where 7 is unrepresentable), and returning None hides the corruption
    behind a nullable column. Every port throws.
    """
    with pytest.raises(ValueError) as exc:
        _decode_read_value(_status_field(INT_MAP), 7)
    assert "7" in str(exc.value)
    assert "intValueMap" in str(exc.value)


def test_non_enum_field_read_is_untouched():
    json_str = """{ "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Order", "children": [
        { "field.long": { "name": "id" } },
        { "identity.primary": { "name": "pk", "@fields": ["id"] } }
      ]} }
    ]} }"""
    assert _decode_read_value(_field_of(json_str, "Order", "id"), 5) == 5


# --- round trip -----------------------------------------------------------


@pytest.mark.parametrize("symbol", ["DRAFT", "PUBLISHED", "ARCHIVED"])
def test_write_then_read_round_trips_to_the_same_symbol(symbol):
    field = _status_field(INT_MAP)
    assert _decode_read_value(field, _coerce_write_value(field, symbol)) == symbol


# --- inheritance (ADR-0039: @intValueMap is read RESOLVING) ---------------


def test_intvaluemap_inherited_through_extends_is_honoured():
    """A concrete field extending a shared abstract enum must encode with the
    inherited map — an own-only read here would silently store the symbol."""
    json_str = """{ "metadata.root": { "package": "acme", "children": [
      { "field.enum": { "name": "StatusEnum", "abstract": true,
        "@values": ["DRAFT","PUBLISHED","ARCHIVED"],
        "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9} } },
      { "object.entity": { "name": "Order", "children": [
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "status", "extends": "StatusEnum" } },
        { "identity.primary": { "name": "pk", "@fields": ["id"] } }
      ]} }
    ]} }"""
    field = _field_of(json_str, "Order", "status")
    assert _coerce_write_value(field, "PUBLISHED") == 5
    assert _decode_read_value(field, 5) == "PUBLISHED"


# --- filter encoding ------------------------------------------------------
#
# The filter band keeps eq/ne/in for an int-backed enum precisely BECAUSE the
# member symbol is supposed to encode to its integer before reaching SQL. Python
# was the only port not encoding on this path, so every query bound the SYMBOL
# against an INTEGER column (pg 22P02). These pin the encoding at the SQL boundary.


def _order_entity(extra: str):
    json_str = f"""{{ "metadata.root": {{ "package": "acme", "children": [
      {{ "object.entity": {{ "name": "Order", "children": [
        {{ "source.rdb": {{ "name": "src", "@table": "orders", "@kind": "table" }} }},
        {{ "field.long": {{ "name": "id" }} }},
        {{ "field.enum": {{ "name": "status", "@values": ["DRAFT","PUBLISHED","ARCHIVED"] {extra} }} }},
        {{ "identity.primary": {{ "name": "pk", "@fields": ["id"] }} }}
      ]}} }}
    ]}} }}"""
    result = MetaDataLoader().load([InMemoryStringSource(json_str, "test.json")])
    assert result.errors == []
    return next(c for c in result.root.children() if c.name == "Order")


def test_filter_eq_on_int_backed_enum_binds_the_int():
    from metaobjects.runtime.object_manager import _compile_filter
    _, params = _compile_filter({"status": {"eq": "PUBLISHED"}}, _order_entity(INT_MAP))
    assert params == [5]


def test_filter_shortcut_equality_on_int_backed_enum_binds_the_int():
    from metaobjects.runtime.object_manager import _compile_filter
    _, params = _compile_filter({"status": "DRAFT"}, _order_entity(INT_MAP))
    assert params == [0]


def test_filter_in_on_int_backed_enum_binds_each_int():
    from metaobjects.runtime.object_manager import _compile_filter
    _, params = _compile_filter({"status": {"in": ["DRAFT", "ARCHIVED"]}}, _order_entity(INT_MAP))
    assert params == [0, 9]


def test_filter_on_string_backed_enum_is_unchanged():
    from metaobjects.runtime.object_manager import _compile_filter
    _, params = _compile_filter({"status": {"eq": "PUBLISHED"}}, _order_entity(""))
    assert params == ["PUBLISHED"]


def test_filter_isnull_binds_no_param_and_is_not_coerced():
    from metaobjects.runtime.object_manager import _compile_filter
    sql, params = _compile_filter({"status": {"isNull": True}}, _order_entity(INT_MAP))
    assert params == []
    assert "IS NULL" in sql
