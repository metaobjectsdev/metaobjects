"""CI gate for the AI-trace field deriver (Unit 2 Slice 3, Python port).

Mirrors the Java LlmTraceFieldDeriverTest: an entity extending LlmCallBase with a
template.prompt carrying @payloadRef/@responseRef gets voRequest/voResponse
field.object jsonb columns injected by the pre_freeze hook; entities missing either
precondition are untouched; the pass is idempotent; and the injected nodes survive
strict validation (ADR-0023).
"""
from __future__ import annotations

from metaobjects.loader.derive_trace_fields import VO_REQUEST, VO_RESPONSE, derive_trace_fields
from metaobjects.loader.meta_data_loader import MetaDataLoader
from metaobjects.loader.sources import InMemoryStringSource, MetaDataFormat
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.shared.base_types import TYPE_FIELD

_FIXTURE = """
metadata:
  package: test::ai
  children:
    - object.entity:
        name: LlmCallBase
        abstract: true
        children:
          - field.uuid: { name: spanId }

    - object.value:
        name: ReqVo
        children:
          - field.string: { name: prompt }

    - object.value:
        name: RespVo
        children:
          - field.string: { name: greeting }
          - field.int:    { name: score }

    # Concrete trace entity → voRequest + voResponse derived.
    - object.entity:
        name: TraceCall
        extends: test::ai::LlmCallBase
        children:
          - source.rdb:       { table: trace_call, role: primary }
          - identity.primary: { fields: ["spanId"] }
          - template.prompt:
              name: ask
              payloadRef: test::ai::ReqVo
              responseRef: test::ai::RespVo

    # Extends LlmCallBase but has no prompt → no derivation.
    - object.entity:
        name: BareCall
        extends: test::ai::LlmCallBase
        children:
          - source.rdb:       { table: bare_call, role: primary }
          - identity.primary: { fields: ["spanId"] }

    # Has a prompt but does NOT extend LlmCallBase → no derivation.
    - object.entity:
        name: PlainEntity
        children:
          - field.uuid:       { name: id }
          - source.rdb:       { table: plain_entity, role: primary }
          - identity.primary: { fields: ["id"] }
          - template.prompt:
              name: ask
              payloadRef: test::ai::ReqVo
              responseRef: test::ai::RespVo
"""


def _load():
    # strict=True proves the DERIVED field.object + @objectRef/@storage attrs pass
    # the same validation passes as authored nodes (the hook fires before them).
    loader = MetaDataLoader(strict=True, pre_freeze=derive_trace_fields)
    return loader.load([InMemoryStringSource(_FIXTURE, format=MetaDataFormat.YAML)])


def _entity(root, short):
    for c in root.own_children():
        if c.name.rsplit("::", 1)[-1] == short:
            return c
    return None


def _own_field(entity, name):
    for c in entity.own_children():
        if c.type == TYPE_FIELD and c.name.rsplit("::", 1)[-1] == name:
            return c
    return None


def test_derives_typed_jsonb_columns_on_trace_entity():
    result = _load()
    assert not result.errors, f"unexpected load errors: {result.errors}"
    trace = _entity(result.root, "TraceCall")
    assert trace is not None

    req = _own_field(trace, VO_REQUEST)
    assert req is not None, "voRequest must be derived"
    assert req.attr(fc.FIELD_ATTR_OBJECT_REF) == "test::ai::ReqVo"
    assert req.attr(fc.FIELD_ATTR_STORAGE) == "jsonb"

    resp = _own_field(trace, VO_RESPONSE)
    assert resp is not None, "voResponse must be derived"
    assert resp.attr(fc.FIELD_ATTR_OBJECT_REF) == "test::ai::RespVo"
    assert resp.attr(fc.FIELD_ATTR_STORAGE) == "jsonb"


def test_skips_entity_without_prompt():
    result = _load()
    bare = _entity(result.root, "BareCall")
    assert _own_field(bare, VO_REQUEST) is None
    assert _own_field(bare, VO_RESPONSE) is None


def test_skips_entity_not_extending_llm_call_base():
    result = _load()
    plain = _entity(result.root, "PlainEntity")
    assert _own_field(plain, VO_REQUEST) is None
    assert _own_field(plain, VO_RESPONSE) is None


def test_is_idempotent():
    result = _load()
    trace = _entity(result.root, "TraceCall")
    # Re-run on the already-derived (now frozen) tree must be a no-op: the existing
    # own fields short-circuit injection before any mutation is attempted.
    derive_trace_fields(result.root)
    count = sum(
        1
        for c in trace.own_children()
        if c.type == TYPE_FIELD and c.name.rsplit("::", 1)[-1] == VO_RESPONSE
    )
    assert count == 1
