"""#210 — template-level payload targets widen to sourceless projections;
assembly origins leave ``object.value``; nested payload targets stay value-only.

Mirrors the TS ``template-payload-target-210.test.ts``. The cross-port
conformance fixtures (``error-value-origin-*``,
``template-payload-ref-sourceless-projection``,
``error-template-payload-ref-sourced-projection``,
``error-payload-nested-object-ref-entity``) byte-gate the envelopes; this file
is the fast in-port pin.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from metaobjects import MetaDataLoader
from metaobjects.errors import ErrorCode
from metaobjects.meta.persistence.origin.origin_constants import (
    ASSEMBLY_ORIGIN_SUBTYPES,
)


def _load(children: list[object]):
    doc = {"metadata.root": {"package": "t::ai", "children": children}}
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "meta.ai.json")
        Path(path).write_text(json.dumps(doc))
        return MetaDataLoader.from_directory(tmpdir)


_AUTHOR = {
    "object.entity": {
        "name": "Author",
        "children": [
            {"source.rdb": {"@table": "authors"}},
            {"field.uuid": {"name": "id"}},
            {"field.string": {"name": "name"}},
            {"identity.primary": {"name": "pk", "@fields": ["id"]}},
        ],
    }
}


def _codes(result) -> list[str]:
    return [e.code for e in result.errors]


def test_payload_ref_sourceless_projection_loads_clean() -> None:
    result = _load([
        _AUTHOR,
        {"object.projection": {"name": "AuthorPayload", "children": [
            {"field.string": {"name": "name", "extends": "t::ai::Author.name"}},
            {"field.string": {"name": "summary"}},
        ]}},
        {"template.prompt": {"name": "P", "@payloadRef": "AuthorPayload",
                             "@textRef": "p/x", "@format": "xml"}},
    ])
    assert result.errors == []


def test_payload_ref_sourced_projection_is_invalid_template() -> None:
    result = _load([
        _AUTHOR,
        {"object.projection": {"name": "AuthorView", "children": [
            {"source.rdb": {"@kind": "view", "@view": "v_author"}},
            {"field.string": {"name": "name", "extends": "t::ai::Author.name"}},
        ]}},
        {"template.prompt": {"name": "P", "@payloadRef": "AuthorView",
                             "@textRef": "p/x", "@format": "xml"}},
    ])
    assert ErrorCode.ERR_INVALID_TEMPLATE in _codes(result)


def test_assembly_origins_rejected_on_value_host() -> None:
    origin_by_subtype = {
        "aggregate": {"origin.aggregate": {"@agg": "count", "@of": "t::ai::Author.id",
                                           "@via": "t::ai::Author.books"}},
        "computed": {"origin.computed": {"@expr": {"op": "isNotNull",
                                                   "arg": {"field": "name"}}}},
        "first": {"origin.first": {"@of": "t::ai::Author.name",
                                   "@via": "t::ai::Author.posts",
                                   "@orderBy": ["name:desc"]}},
    }
    assert set(origin_by_subtype) == set(ASSEMBLY_ORIGIN_SUBTYPES)
    for sub, origin in origin_by_subtype.items():
        field = (
            {"field.boolean": {"name": "x", "children": [origin]}}
            if sub == "computed"
            else {"field.string": {"name": "x", "children": [origin]}}
            if sub == "first"
            else {"field.int": {"name": "x", "children": [origin]}}
        )
        result = _load([
            {"object.value": {"name": "NoteVO", "children": [{"field.string": {"name": "n"}}]}},
            {"object.value": {"name": "Bad", "children": [field]}},
        ])
        assert ErrorCode.ERR_SUBTYPE_RULE_VIOLATION in _codes(result), sub


def test_passthrough_stays_legal_on_value_host() -> None:
    result = _load([
        _AUTHOR,
        {"object.value": {"name": "Args", "children": [
            {"field.string": {"name": "authorName", "children": [
                {"origin.passthrough": {"@from": "t::ai::Author.name"}},
            ]}},
        ]}},
    ])
    assert result.errors == []


def test_nested_payload_ref_to_entity_rejected() -> None:
    result = _load([
        _AUTHOR,
        {"object.value": {"name": "ReviewRequest", "children": [
            {"field.string": {"name": "instructions"}},
            {"field.object": {"name": "author", "@objectRef": "t::ai::Author"}},
        ]}},
        {"template.prompt": {"name": "P", "@payloadRef": "ReviewRequest",
                             "@textRef": "p/x", "@format": "xml"}},
    ])
    assert ErrorCode.ERR_SUBTYPE_RULE_VIOLATION in _codes(result)


def test_nested_payload_ref_to_sourceless_projection_also_rejected() -> None:
    result = _load([
        _AUTHOR,
        {"object.projection": {"name": "AuthorBrief", "children": [
            {"field.string": {"name": "name", "extends": "t::ai::Author.name"}},
        ]}},
        {"object.value": {"name": "ReviewRequest", "children": [
            {"field.object": {"name": "author", "@objectRef": "t::ai::AuthorBrief"}},
        ]}},
        {"template.prompt": {"name": "P", "@payloadRef": "ReviewRequest",
                             "@textRef": "p/x", "@format": "xml"}},
    ])
    assert ErrorCode.ERR_SUBTYPE_RULE_VIOLATION in _codes(result)


def test_nested_payload_ref_to_value_nests_clean() -> None:
    result = _load([
        {"object.value": {"name": "Inner", "children": [{"field.string": {"name": "s"}}]}},
        {"object.value": {"name": "Mid", "children": [
            {"field.object": {"name": "inner", "@objectRef": "t::ai::Inner"}},
        ]}},
        {"object.value": {"name": "Outer", "children": [
            {"field.object": {"name": "mid", "@objectRef": "t::ai::Mid"}},
        ]}},
        {"template.prompt": {"name": "P", "@payloadRef": "Outer",
                             "@textRef": "p/x", "@format": "xml"}},
    ])
    assert result.errors == []
