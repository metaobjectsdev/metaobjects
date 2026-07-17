"""FR-024 §7 (#214) — write-through entity read-view codegen (Python port).

A write-through entity declares BOTH a writable ``source.rdb`` (@kind:table) and a
read-only replica ``source.rdb`` (@role:replica @kind:view) plus DERIVED fields (a
field carrying an ``origin.*`` child). The codegen contract mirrors the TS reference
(``b4eee456``): the read model ``<Name>`` carries the derived field, while the write
models ``<Name>Create`` / ``<Name>Patch`` EXCLUDE it (it is view-computed, not client
input). The router IS emitted (a write-through entity is writable), regardless of
source declaration order.

Canonical fixture: Customer + write-through Order (replica view ``v_order_with_customer``,
derived ``customerName`` passthrough from ``Customer.name`` via the ``customer`` join).
"""
from __future__ import annotations

import json

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes
from metaobjects import load_string
from metaobjects.codegen.generators.entity_model import render_entity_model
from metaobjects.codegen.generators.filter_allowlist_generator import render_filter_allowlist
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.meta.core.object.meta_object import MetaObject

# Table source declared FIRST.
_META = {
    "metadata.root": {
        "package": "acme::sales",
        "children": [
            {
                "object.entity": {
                    "name": "Customer",
                    "children": [
                        {"source.rdb": {"@table": "customers"}},
                        {"field.long": {"name": "id"}},
                        {"field.string": {"name": "name", "@required": True}},
                        {"identity.primary": {"name": "pk", "@fields": ["id"], "@generation": "increment"}},
                    ],
                }
            },
            {
                "object.entity": {
                    "name": "Order",
                    "children": [
                        {"source.rdb": {"@role": "primary", "@table": "orders"}},
                        {"source.rdb": {"@role": "replica", "@kind": "view", "@view": "v_order_with_customer"}},
                        {"field.long": {"name": "id"}},
                        {"field.long": {"name": "customerId", "@required": True}},
                        {"field.string": {"name": "customerName", "children": [
                            {"origin.passthrough": {"@from": "Customer.name", "@via": "Order.customer"}}]}},
                        {"relationship.association": {"name": "customer", "@objectRef": "Customer", "@cardinality": "one"}},
                        {"identity.primary": {"name": "pk", "@fields": ["id"], "@generation": "increment"}},
                        {"identity.reference": {"name": "ref_customer", "@fields": ["customerId"], "@references": "Customer"}},
                    ],
                }
            },
        ],
    }
}

# Same, but with the replica VIEW source declared BEFORE the table — guards that
# write-through detection / router emission is source-order-independent.
_META_VIEW_FIRST = json.loads(json.dumps(_META))
_order = _META_VIEW_FIRST["metadata.root"]["children"][1]["object.entity"]["children"]
_order[0], _order[1] = _order[1], _order[0]  # swap the two source.rdb declarations


def _order_obj(meta: dict) -> MetaObject:
    root = load_string(json.dumps(meta)).root
    return next(c for c in root.own_children()
                if isinstance(c, MetaObject) and c.name == "Order")


def test_read_model_carries_derived_write_models_exclude_it() -> None:
    order = _order_obj(_META)
    assert order.is_write_through()

    # render_entity_model emits the whole module: the read model `Order` plus the
    # write shapes `OrderCreate` / `OrderPatch`. EXEC it (a syntax/name/import defect
    # fails here), then introspect each Pydantic model's field set.
    src = render_entity_model(order)
    ns: dict[str, object] = {}
    exec(compile(src, "<Order model>", "exec"), ns)  # noqa: S102

    read_fields = set(ns["Order"].model_fields)
    create_fields = set(ns["OrderCreate"].model_fields)
    patch_fields = set(ns["OrderPatch"].model_fields)

    # the read model carries the derived field; the write shapes EXCLUDE it.
    assert "customerName" in read_fields
    assert "customerName" not in create_fields
    assert "customerName" not in patch_fields
    # the stored writable field is present everywhere.
    assert "customerId" in read_fields
    assert "customerId" in create_fields
    assert "customerId" in patch_fields


def test_write_through_router_is_emitted_regardless_of_source_order() -> None:
    # A write-through entity is writable → it gets a CRUD router (a read-only
    # projection returns None). Order-independent: the view-first fixture too.
    assert render_router(_order_obj(_META)) is not None
    assert render_router(_order_obj(_META_VIEW_FIRST)) is not None
    assert _order_obj(_META_VIEW_FIRST).is_write_through()


def test_write_through_filter_allowlist_is_emitted_with_the_router() -> None:
    # The generated router imports the entity's filter allowlist, so the allowlist
    # generator MUST emit for a write-through entity too — regardless of source order,
    # else a view-first router imports a never-generated module (FastAPI startup crash).
    assert render_filter_allowlist(_order_obj(_META)) is not None
    assert render_filter_allowlist(_order_obj(_META_VIEW_FIRST)) is not None
