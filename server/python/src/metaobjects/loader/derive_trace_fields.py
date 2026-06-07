"""AI-trace pre-freeze pass: inject typed ``voRequest``/``voResponse``
``field.object`` jsonb columns onto entities that extend ``LlmCallBase`` and carry
a nested ``template.prompt`` with ``@payloadRef``/``@responseRef``.

Cross-port mirror of the TS reference (``codegen-ts/src/ai/derive-trace-fields.ts``)
and the Java ``LlmTraceFieldDeriver``. The TS reference wires this codegen-only
because its runtime persists via a direct row-write (no runtime metadata). The
Python ``ObjectManager`` runtime is METADATA-DRIVEN — the generated
``record_<entity>`` helper sets ``voResponse`` on the row and ``ObjectManager.create``
maps it to a jsonb column by reading the runtime-loaded entity's fields. So in
Python (like Java/OMDB) the derivation must also reach the runtime load path; it is
exposed as a loader ``pre_freeze`` hook (see ``MetaDataLoader``) usable by BOTH the
codegen path and a runtime loader.

The injected fields carry ``@objectRef`` + ``@storage="jsonb"`` so the existing
owned-object typed-jsonb codec handles them — identical to a hand-authored
``field.object``. The pass is idempotent: an own field of the same name is left
untouched, so explicit authoring still wins. It runs after ``extends`` resolution
and before the validation passes, so the derived nodes are validated like authored
ones.
"""
from __future__ import annotations

from metaobjects.meta.core.attr.attr_constants import ATTR_SUBTYPE_STRING
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.template import template_constants as tc
from metaobjects.shared.base_types import TYPE_FIELD, TYPE_OBJECT, TYPE_TEMPLATE

#: Short name of the shipped abstract base every trace entity extends.
LLM_CALL_BASE = "LlmCallBase"
#: Derived field names.
VO_REQUEST = "voRequest"
VO_RESPONSE = "voResponse"
#: ``@storage`` value selecting the typed-jsonb owned-object codec.
_STORAGE_JSONB = "jsonb"


def _short(name: str | None) -> str:
    """Last ``::`` segment of a (possibly package-qualified) name."""
    return name.rsplit("::", 1)[-1] if name else (name or "")


def _extends_base(obj: MetaData, base: str) -> bool:
    """Walk the resolved super chain for a node whose short name == ``base``."""
    cur = obj.super_data
    while cur is not None:
        if _short(cur.name) == base:
            return True
        cur = cur.super_data
    return False


def _own_prompt(obj: MetaData) -> MetaData | None:
    """First OWN ``template.prompt`` child of ``obj``, or ``None``."""
    for c in obj.own_children():
        if c.type == TYPE_TEMPLATE and c.sub_type == tc.TEMPLATE_SUBTYPE_PROMPT:
            return c
    return None


def _inject(entity: MetaData, field_name: str, object_ref: str) -> None:
    """Inject a ``field.object`` child with ``@objectRef`` + ``@storage="jsonb"``,
    unless an own field of that name already exists (idempotent)."""
    for c in entity.own_children():
        if c.type == TYPE_FIELD and _short(c.name) == field_name:
            return
    f = MetaField(TYPE_FIELD, fc.FIELD_SUBTYPE_OBJECT, field_name)
    f.set_attr(fc.FIELD_ATTR_OBJECT_REF, object_ref, ATTR_SUBTYPE_STRING)
    f.set_attr(fc.FIELD_ATTR_STORAGE, _STORAGE_JSONB, ATTR_SUBTYPE_STRING)
    entity.add_child(f)


def derive_trace_fields(root: MetaData) -> None:
    """For every entity under ``root`` that (1) extends ``LlmCallBase`` and (2) has
    an own ``template.prompt`` carrying ``@payloadRef``/``@responseRef``, inject
    ``voRequest``/``voResponse`` ``field.object`` jsonb columns. Idempotent.

    Designed to be passed as ``MetaDataLoader(pre_freeze=...)`` /
    ``from_directory(..., pre_freeze=...)``.
    """
    for obj in root.own_children():
        if obj.type != TYPE_OBJECT:
            continue
        if not _extends_base(obj, LLM_CALL_BASE):
            continue
        prompt = _own_prompt(obj)
        if prompt is None:
            continue
        payload_ref = prompt.attr(tc.TEMPLATE_ATTR_PAYLOAD_REF)
        response_ref = prompt.attr(tc.TEMPLATE_ATTR_RESPONSE_REF)
        if isinstance(payload_ref, str) and payload_ref:
            _inject(obj, VO_REQUEST, payload_ref)
        if isinstance(response_ref, str) and response_ref:
            _inject(obj, VO_RESPONSE, response_ref)
