"""ObjectManager's physical table name comes from a DECLARED source, or nowhere.

#248: participation in persistence derives from a declared ``source.rdb``, never
from the object subtype. A concrete ``object.entity`` declaring no source at all
loads with ZERO errors — the loader's one-primary-source rule fires only once an
object declares at least one — and the runtime was answering "which table does
this live in?" with ``entity.name``, a name nothing created and no migration will.
Every read, write and delete it issued went to a fabricated relation.

Codegen's ``resolve_table_name`` already returned ``None`` for that shape, and the
M:N descriptor already raised on it. The runtime is now the third caller of the
same resolver rather than the one place that kept its own copy and guessed.
"""
from __future__ import annotations

import pytest

from metaobjects.loader.meta_data_loader import MetaDataLoader
from metaobjects.loader.sources import InMemoryStringSource
from metaobjects.runtime.object_manager import ObjectManager

SOURCELESS = """{ "metadata.root": { "package": "acme", "children": [
  { "object.entity": { "name": "Ledger", "children": [
    { "field.long":   { "name": "id" } },
    { "field.string": { "name": "note" } },
    { "identity.primary": { "name": "pk", "@fields": ["id"] } }
  ]} }
]} }"""

SOURCED = """{ "metadata.root": { "package": "acme", "children": [
  { "object.entity": { "name": "Booking", "children": [
    { "source.rdb": { "name": "primary", "@table": "bookings" } },
    { "field.long":   { "name": "id" } },
    { "identity.primary": { "name": "pk", "@fields": ["id"] } }
  ]} }
]} }"""

# Derived declares no source of its own and inherits Booking's via `extends`
# (ADR-0039). An own-only read here would call it sourceless and refuse a valid
# entity — the failure direction that would make this fix worse than the bug.
INHERITED = """{ "metadata.root": { "package": "acme", "children": [
  { "object.entity": { "name": "Booking", "children": [
    { "source.rdb": { "name": "primary", "@table": "bookings" } },
    { "field.long":   { "name": "id" } },
    { "identity.primary": { "name": "pk", "@fields": ["id"] } }
  ]} },
  { "object.entity": { "name": "Derived", "extends": "Booking", "children": [
    { "field.string": { "name": "extra" } }
  ]} }
]} }"""


def _om(json_str: str) -> ObjectManager:
    result = MetaDataLoader().load([InMemoryStringSource(json_str, "test.json")])
    assert result.errors == []
    return ObjectManager(result.root, driver=None)


def test_a_sourceless_entity_loads_cleanly() -> None:
    """The load-bearing precondition, asserted rather than assumed: this shape is
    something the loader accepts, which is why the runtime can be handed it."""
    result = MetaDataLoader().load([InMemoryStringSource(SOURCELESS, "test.json")])
    assert result.errors == []


def test_a_sourceless_entity_raises_instead_of_fabricating_a_table_name() -> None:
    om = _om(SOURCELESS)
    entity = om._require_entity("Ledger")
    with pytest.raises(ValueError) as exc:
        om._table_name(entity)
    message = str(exc.value)
    assert "Ledger" in message
    assert "source.rdb" in message
    # It must never offer the fabricated name as if it were an answer.
    assert 'table "Ledger"' not in message


def test_a_sourced_entity_resolves_its_declared_physical_name() -> None:
    om = _om(SOURCED)
    assert om._table_name(om._require_entity("Booking")) == "bookings"


def test_an_entity_inheriting_its_source_resolves_the_inherited_name() -> None:
    om = _om(INHERITED)
    assert om._table_name(om._require_entity("Derived")) == "bookings"
