"""An authored ``<type>.base`` is refused — every base subtype is an abstract anchor.

Every registered ``base`` subtype is the shared root that concrete subtypes inherit
their attrs and child rules from. It has no runtime semantics and no concrete
representation: ``spec/metamodel/object.json`` says so in as many words ("Has no
runtime semantics of its own; not authored directly"), and every ``base`` entry's
description in the byte-gated registry manifest opens with "Abstract".

The JVM enforced this by accident — its impl classes are ``public abstract``, so
instantiating one failed — while TypeScript, C# and Python accepted it outright. The
same document therefore loaded on three ports and failed to load on two, which is
exactly the cross-port conformance gap the corpora exist to catch. It survived because
every ``*.base`` subtype sits in the registry corpus's own ``untestedSubTypes`` list;
``fixtures/conformance/error-abstract-subtype-authored`` closes that.
"""
from __future__ import annotations

import json

import pytest

from metaobjects import load_string
from metaobjects.errors import ErrorCode

# Every registered base subtype, authored in a position its type is legal in.
CASES = {
    "object.base": {"object.base": {"name": "P", "children": [{"field.long": {"name": "id"}}]}},
    "field.base": {"object.entity": {"name": "E1", "children": [{"field.base": {"name": "f"}}]}},
    "source.base": {"object.entity": {"name": "E2", "children": [
        {"source.base": {"name": "s"}},
        {"field.long": {"name": "id"}},
    ]}},
    "validator.base": {"object.entity": {"name": "E3", "children": [
        {"field.string": {"name": "s", "children": [{"validator.base": {"name": "v"}}]}},
    ]}},
    "view.base": {"object.entity": {"name": "E4", "children": [
        {"field.string": {"name": "s", "children": [{"view.base": {"name": "v"}}]}},
    ]}},
    "attr.base": {"object.entity": {"name": "E5", "children": [
        {"field.string": {"name": "s", "children": [
            {"attr.base": {"name": "a", "value": "x"}},
        ]}},
    ]}},
}


def _load(node: dict):
    return load_string(json.dumps(
        {"metadata.root": {"package": "acme", "children": [node]}}))


@pytest.mark.parametrize("label", sorted(CASES))
def test_authored_base_subtype_is_refused(label: str) -> None:
    result = _load(CASES[label])
    codes = [e.code for e in result.errors]
    assert ErrorCode.ERR_ABSTRACT_SUBTYPE_AUTHORED in codes, codes
    message = next(e.message for e in result.errors
                   if e.code is ErrorCode.ERR_ABSTRACT_SUBTYPE_AUTHORED)
    assert label in message
    assert "abstract registry anchor" in message


def test_the_concrete_sibling_of_every_refused_case_still_loads() -> None:
    """The control arm. Without it, a check that refused every node would pass above."""
    ok = {"object.entity": {"name": "Fine", "children": [
        {"source.rdb": {"name": "primary", "@table": "fines"}},
        {"field.long": {"name": "id"}},
        {"field.string": {"name": "s", "children": [{"validator.required": {}}]}},
        {"field.currency": {"name": "price", "@currency": "USD", "children": [
            {"view.currency": {"name": "v"}},
        ]}},
        {"identity.primary": {"name": "pk", "@fields": ["id"]}},
    ]}}
    assert not _load(ok).errors


def test_an_inline_default_still_reaches_the_polymorphic_attr_subtype() -> None:
    """`attr.base` is REAL — it is what an untyped `@default` resolves to, with its value
    type following the owning field. The loader picks it; an author never names it. The
    rule refuses the authored spelling and must leave this path alone."""
    result = _load({"object.entity": {"name": "Item", "children": [
        {"source.rdb": {"name": "primary", "@table": "items"}},
        {"field.long": {"name": "id"}},
        {"field.boolean": {"name": "enabled", "@default": False}},
        {"identity.primary": {"name": "pk", "@fields": ["id"]}},
    ]}})
    assert not result.errors
    item = next(c for c in result.root.children() if c.name.endswith("Item"))
    enabled = next(f for f in item.fields() if f.name == "enabled")
    assert enabled.attrs().get("default") is False
