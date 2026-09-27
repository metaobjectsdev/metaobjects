"""A SOURCELESS entity — ``object.entity`` with an ``identity.primary`` and no ``source.*`` —
is a record in a store MetaObjects does not manage (a MongoDB collection, a Cassandra table, a
Neo4j node, a remote API). It gets no router and no table (#248); the adopter owns the data
access. What it still needs is the wire contract: the ``<E>Create`` / ``<E>Patch`` models (the
entity generator already emits them for every entity) and the filter allowlist its own list
endpoint validates a query against. Value objects are unchanged: ADR-0028 forbids them an
identity.

Mirror of the TypeScript ``sourceless-entity-surface.test.ts``.
"""
import json

from metaobjects import InMemoryStringSource, MetaDataFormat, MetaDataLoader
from metaobjects.codegen.generators.entity_model import EntityModelGenerator
from metaobjects.codegen.generators.filter_allowlist_generator import render_filter_allowlist
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.codegen.generator import GenContext
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.instance_artifacts import is_sourceless_entity
from metaobjects.meta.core.object.meta_object import MetaObject

MODEL = {"metadata.root": {"package": "shop", "children": [
    {"object.value": {"name": "LineItem", "children": [
        {"field.string": {"name": "sku", "@required": True}},
    ]}},
    {"object.entity": {"name": "Order", "children": [
        {"field.string": {"name": "id"}},
        {"field.string": {"name": "customerEmail", "@required": True, "@filterable": True}},
        {"field.enum": {"name": "status", "@values": ["NEW", "SHIPPED"], "@filterable": True}},
        {"identity.primary": {"name": "id", "@fields": "id"}},
    ]}},
    {"object.entity": {"name": "Note", "children": [
        {"field.string": {"name": "text"}},
    ]}},
]}}


def _objects() -> dict[str, MetaObject]:
    result = MetaDataLoader().load(
        [InMemoryStringSource(json.dumps(MODEL), id="m.json", format=MetaDataFormat.JSON)]
    )
    assert not result.errors, result.errors
    return {o.name: o for o in result.root.own_children() if isinstance(o, MetaObject)}


def test_is_sourceless_entity_needs_an_identity_and_no_source() -> None:
    objs = _objects()
    assert is_sourceless_entity(objs["Order"]) is True
    assert is_sourceless_entity(objs["LineItem"]) is False  # a value: no identity, ever
    assert is_sourceless_entity(objs["Note"]) is False  # no identity: nothing to address


def test_sourceless_entity_gets_a_filter_allowlist_but_no_router() -> None:
    order = _objects()["Order"]
    assert render_router(order) is None
    out = render_filter_allowlist(order)
    assert out is not None
    assert '"customerEmail"' in out
    assert '"status"' in out


def test_value_object_gets_no_filter_allowlist() -> None:
    assert render_filter_allowlist(_objects()["LineItem"]) is None


def test_sourceless_entity_gets_create_and_patch_models() -> None:
    objs = _objects()
    root_objs = list(objs.values())
    ctx = GenContext(entities=root_objs, loaded_root=root_objs[0].parent, matches=lambda _e: True,
                     config=GenConfig(out_dir=""), warn=lambda _m: None)
    files = {f.path: f.content for f in EntityModelGenerator().generate(ctx)}
    order = next(c for p, c in files.items() if p.endswith("Order.py"))
    assert "class OrderCreate(BaseModel)" in order
    assert "class OrderPatch(BaseModel)" in order
