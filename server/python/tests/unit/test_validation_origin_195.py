"""#195 — per-capability origin validation (Phase 4 Python parity).

Mirrors the TS reference test suite (loader-origin-validation.test.ts, commit
63943d0c): the 20 semantic-validation cases for the four #195 projection
read-model origin capabilities — origin.aggregate @agg:any|all|collect,
origin.computed, origin.first. Every case is loaded through the full pipeline
(parse → merge → super-resolve → validate) so it exercises the same code path
production loads take.
"""
from __future__ import annotations

import json

from metaobjects.errors import ErrorCode, MetaError
from metaobjects.loader.meta_data_loader import MetaDataLoader
from metaobjects.loader.sources import InMemoryStringSource


def _load(children: list[dict]) -> list[MetaError]:
    """Load a single-package root of *children* and return the loader errors."""
    doc = {"metadata.root": {"package": "test", "children": children}}
    result = MetaDataLoader().load([InMemoryStringSource(json.dumps(doc))])
    return result.errors


def _has(errors: list[MetaError], code: ErrorCode, needle: str) -> bool:
    return any(e.code == code and needle in e.message for e in errors)


# ---------------------------------------------------------------------------
# A Session/Turn graph + a projection carrying one origin field (configurable).
# Mirrors the TS `sessionModel`.
# ---------------------------------------------------------------------------
def _session_model(origin_field: dict) -> list[dict]:
    return [
        {
            "object.entity": {
                "name": "Session",
                "children": [
                    {"field.long": {"name": "id"}},
                    {"relationship.association": {"name": "turns", "@objectRef": "Turn", "@cardinality": "many"}},
                    {"identity.primary": {"name": "id", "@fields": "id"}},
                ],
            }
        },
        {
            "object.entity": {
                "name": "Turn",
                "children": [
                    {"field.long": {"name": "id"}},
                    {"field.boolean": {"name": "success"}},
                    {"field.string": {"name": "label"}},
                    {"field.timestamp": {"name": "createdAt"}},
                    {"identity.primary": {"name": "id", "@fields": "id"}},
                ],
            }
        },
        {
            "object.projection": {
                "name": "SessionSummary",
                "children": [
                    {"source.rdb": {"@kind": "view", "@table": "v_session"}},
                    {"field.long": {"name": "id", "extends": "Session.id"}},
                    origin_field,
                    {"identity.primary": {"name": "id", "extends": "Session.id"}},
                ],
            }
        },
    ]


# ---------------------------------------------------------------------------
# #195 origin.aggregate @agg any|all validation
# ---------------------------------------------------------------------------
def test_any_boolean_filter_via_no_of_ok() -> None:
    errors = _load(_session_model({
        "field.boolean": {"name": "hasError", "children": [
            {"origin.aggregate": {"@agg": "any", "@via": "Session.turns", "@filter": {"success": False}}},
        ]},
    }))
    assert errors == []


def test_all_vacuous_truth_ok() -> None:
    errors = _load(_session_model({
        "field.boolean": {"name": "allOk", "children": [
            {"origin.aggregate": {"@agg": "all", "@via": "Session.turns", "@filter": {"success": True}}},
        ]},
    }))
    assert errors == []


def test_any_without_filter_errors() -> None:
    errors = _load(_session_model({
        "field.boolean": {"name": "hasError", "children": [
            {"origin.aggregate": {"@agg": "any", "@via": "Session.turns"}},
        ]},
    }))
    assert _has(errors, ErrorCode.ERR_INVALID_ORIGIN, "@filter")


def test_any_with_of_forbidden() -> None:
    errors = _load(_session_model({
        "field.boolean": {"name": "hasError", "children": [
            {"origin.aggregate": {"@agg": "any", "@via": "Session.turns", "@filter": {"success": False}, "@of": "Turn.success"}},
        ]},
    }))
    assert _has(errors, ErrorCode.ERR_INVALID_ORIGIN, "@of")


def test_any_on_non_boolean_field_errors() -> None:
    errors = _load(_session_model({
        "field.string": {"name": "hasError", "children": [
            {"origin.aggregate": {"@agg": "any", "@via": "Session.turns", "@filter": {"success": False}}},
        ]},
    }))
    assert _has(errors, ErrorCode.ERR_INVALID_ORIGIN, "boolean")


def test_any_on_isarray_field_inverse_rule() -> None:
    errors = _load(_session_model({
        "field.boolean": {"name": "hasError", "isArray": True, "children": [
            {"origin.aggregate": {"@agg": "any", "@via": "Session.turns", "@filter": {"success": False}}},
        ]},
    }))
    assert any(
        e.code == ErrorCode.ERR_INVALID_ORIGIN and ("isArray" in e.message or "array" in e.message)
        for e in errors
    )


# ---------------------------------------------------------------------------
# #195 origin.aggregate @agg collect validation
# ---------------------------------------------------------------------------
def test_collect_isarray_of_via_ok() -> None:
    errors = _load(_session_model({
        "field.string": {"name": "labels", "isArray": True, "children": [
            {"origin.aggregate": {"@agg": "collect", "@of": "Turn.label", "@via": "Session.turns", "@distinct": True}},
        ]},
    }))
    assert errors == []


def test_collect_on_non_array_field_errors() -> None:
    errors = _load(_session_model({
        "field.string": {"name": "labels", "children": [
            {"origin.aggregate": {"@agg": "collect", "@of": "Turn.label", "@via": "Session.turns"}},
        ]},
    }))
    assert any(
        e.code == ErrorCode.ERR_INVALID_ORIGIN and ("isArray" in e.message or "array" in e.message)
        for e in errors
    )


def test_collect_element_type_must_match_of() -> None:
    errors = _load(_session_model({
        "field.long": {"name": "labels", "isArray": True, "children": [
            {"origin.aggregate": {"@agg": "collect", "@of": "Turn.label", "@via": "Session.turns"}},
        ]},
    }))
    assert any(
        e.code == ErrorCode.ERR_INVALID_ORIGIN
        and any(w in e.message.lower() for w in ("type", "subtype", "match"))
        for e in errors
    )


def test_distinct_on_non_collect_aggregate_errors() -> None:
    errors = _load(_session_model({
        "field.long": {"name": "turnCount", "children": [
            {"origin.aggregate": {"@agg": "count", "@of": "Turn.id", "@via": "Session.turns", "@distinct": True}},
        ]},
    }))
    assert _has(errors, ErrorCode.ERR_INVALID_ORIGIN, "distinct")


def test_orderby_with_distinct_on_collect_errors() -> None:
    errors = _load(_session_model({
        "field.string": {"name": "labels", "isArray": True, "children": [
            {"origin.aggregate": {"@agg": "collect", "@of": "Turn.label", "@via": "Session.turns", "@distinct": True, "@orderBy": ["label:asc"]}},
        ]},
    }))
    assert _has(errors, ErrorCode.ERR_INVALID_ORIGIN, "orderBy")


def test_non_collect_aggregate_on_isarray_inverse_rule() -> None:
    errors = _load(_session_model({
        "field.long": {"name": "turnCount", "isArray": True, "children": [
            {"origin.aggregate": {"@agg": "count", "@of": "Turn.id", "@via": "Session.turns"}},
        ]},
    }))
    assert any(
        e.code == ErrorCode.ERR_INVALID_ORIGIN and ("isArray" in e.message or "array" in e.message)
        for e in errors
    )


# ---------------------------------------------------------------------------
# #195 origin.computed validation
# ---------------------------------------------------------------------------
def _computed_model(field: dict) -> list[dict]:
    return [
        {
            "object.entity": {
                "name": "LlmCall",
                "children": [
                    {"field.long": {"name": "id"}},
                    {"field.string": {"name": "payloadJson"}},
                    {"field.long": {"name": "durationMs"}},
                    {"identity.primary": {"name": "id", "@fields": "id"}},
                ],
            }
        },
        {
            "object.projection": {
                "name": "LlmCallSummary",
                "children": [
                    {"source.rdb": {"@kind": "view", "@table": "v_llm"}},
                    {"field.long": {"name": "id", "extends": "LlmCall.id"}},
                    field,
                    {"identity.primary": {"name": "id", "extends": "LlmCall.id"}},
                ],
            }
        },
    ]


def test_computed_isnotnull_over_base_field_ok() -> None:
    errors = _load(_computed_model({
        "field.boolean": {"name": "hasPayload", "children": [
            {"origin.computed": {"@expr": {"op": "isNotNull", "arg": {"field": "payloadJson"}}}},
        ]},
    }))
    assert errors == []


def test_computed_inferred_boolean_vs_declared_string_mismatch() -> None:
    errors = _load(_computed_model({
        "field.string": {"name": "hasPayload", "children": [
            {"origin.computed": {"@expr": {"op": "isNotNull", "arg": {"field": "payloadJson"}}}},
        ]},
    }))
    assert any(e.code == ErrorCode.ERR_COMPUTED_TYPE_MISMATCH for e in errors)


def test_computed_field_ref_to_nonexistent_base_field_errors() -> None:
    errors = _load(_computed_model({
        "field.boolean": {"name": "hasPayload", "children": [
            {"origin.computed": {"@expr": {"op": "isNotNull", "arg": {"field": "nope"}}}},
        ]},
    }))
    assert any(
        "nope" in e.message
        and e.code in (ErrorCode.ERR_INVALID_ORIGIN, ErrorCode.ERR_UNKNOWN_EXPR_NODE)
        for e in errors
    )


def test_computed_unknown_expression_op_errors() -> None:
    errors = _load(_computed_model({
        "field.boolean": {"name": "hasPayload", "children": [
            {"origin.computed": {"@expr": {"op": "regexp", "arg": {"field": "payloadJson"}}}},
        ]},
    }))
    assert any(e.code == ErrorCode.ERR_UNKNOWN_EXPR_NODE for e in errors)


# ---------------------------------------------------------------------------
# #195 origin.first validation
# ---------------------------------------------------------------------------
def test_first_of_via_orderby_filter_non_required_ok() -> None:
    errors = _load(_session_model({
        "field.string": {"name": "latestLabel", "children": [
            {"origin.first": {"@of": "Turn.label", "@via": "Session.turns", "@orderBy": ["createdAt:desc"], "@filter": {"success": True}}},
        ]},
    }))
    assert errors == []


def test_first_on_required_field_errors() -> None:
    errors = _load(_session_model({
        "field.string": {"name": "latestLabel", "@required": True, "children": [
            {"origin.first": {"@of": "Turn.label", "@via": "Session.turns", "@orderBy": ["createdAt:desc"]}},
        ]},
    }))
    assert _has(errors, ErrorCode.ERR_INVALID_ORIGIN, "required")


def test_first_of_type_preservation() -> None:
    errors = _load(_session_model({
        "field.long": {"name": "latestLabel", "children": [
            {"origin.first": {"@of": "Turn.label", "@via": "Session.turns", "@orderBy": ["createdAt:desc"]}},
        ]},
    }))
    assert any(
        e.code == ErrorCode.ERR_INVALID_ORIGIN
        and any(w in e.message.lower() for w in ("type", "subtype", "match"))
        for e in errors
    )


def test_first_orderby_key_not_resolving_errors() -> None:
    errors = _load(_session_model({
        "field.string": {"name": "latestLabel", "children": [
            {"origin.first": {"@of": "Turn.label", "@via": "Session.turns", "@orderBy": ["nope:desc"]}},
        ]},
    }))
    assert any(
        e.code == ErrorCode.ERR_INVALID_ORIGIN and ("nope" in e.message or "orderBy" in e.message)
        for e in errors
    )
