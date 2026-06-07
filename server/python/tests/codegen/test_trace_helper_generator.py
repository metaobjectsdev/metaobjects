"""Tests for the ``trace-helper`` generator (AI LLM-call trace persistence,
Unit 2 Slice 2 — Python port).

The generator emits one ``record_<entity>.py`` per concrete ``object.entity`` that
(a) transitively ``extends`` ``LlmCallBase`` AND (b) nests a ``template.prompt``
carrying ``@responseRef`` / ``@payloadRef``. The emitted ``record_<snake>`` runs the
tolerant ``extract`` of the raw response TEXT against a baked ``_RESPONSE_SCHEMA``,
derives the call status from the lost-required gate, builds the base trace row,
attaches typed ``voRequest``/``voResponse``, and persists ONCE via the recorder.

Mirrors ``test_extractor_generator.py``'s materialize→import→invoke harness. The
cross-port references are the TS ``trace-helper-file.ts`` and the Java
``LlmTraceHelperGenerator``.
"""
from __future__ import annotations

import metaobjects.core_types  # noqa: F401 — side-effect: registers attr classes
import pytest
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator import GenContext
from metaobjects.codegen.generators.trace_helper_generator import (
    TraceHelperGenerator,
    render_trace_helper,
    trace_helper_generator,
)
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.identity.identity_constants import IDENTITY_SUBTYPE_PRIMARY
from metaobjects.meta.core.identity.meta_identity import MetaIdentity
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.meta.persistence.source.meta_source import MetaSource
from metaobjects.meta.persistence.source.source_constants import SOURCE_SUBTYPE_RDB
from metaobjects.meta.template import template_constants as tc
from metaobjects.meta.template.meta_template import MetaTemplate
from metaobjects.runtime import LlmCallInput, NullLlmCallRecorder
from metaobjects.shared.base_types import (
    SUBTYPE_ROOT,
    TYPE_FIELD,
    TYPE_IDENTITY,
    TYPE_METADATA,
    TYPE_OBJECT,
    TYPE_SOURCE,
    TYPE_TEMPLATE,
)


# ---------------------------------------------------------------------------
# Builders — an abstract LlmCallBase, a GreetingResponse object.value, and a
# concrete GreetingCall trace entity extending LlmCallBase with source.rdb +
# identity.primary + a nested template.prompt (payloadRef + responseRef).
# ---------------------------------------------------------------------------


def _field(name: str, sub: str, **attrs: object) -> MetaField:
    f = MetaField(TYPE_FIELD, sub, name)
    for k, v in attrs.items():
        f.set_attr(k, v)
    return f


def _value_object(name: str, fields: list[MetaField]) -> MetaObject:
    obj = MetaObject(TYPE_OBJECT, "value", name)
    for f in fields:
        obj.add_child(f)
    return obj


def _llm_call_base() -> MetaObject:
    """A minimal abstract ``LlmCallBase`` — only the fields ``build_llm_call_row``
    reads via the input matter at codegen time; the abstract flag + name drive the
    ``_extends_base`` short-name walk."""
    base = MetaObject(TYPE_OBJECT, "entity", "LlmCallBase")
    base.is_abstract = True
    return base


def _greeting_response() -> MetaObject:
    return _value_object(
        "GreetingResponse",
        [
            _field("greeting", fc.FIELD_SUBTYPE_STRING, **{fc.FIELD_ATTR_REQUIRED: True}),
            _field("score", fc.FIELD_SUBTYPE_INT),
        ],
    )


def _prompt() -> MetaTemplate:
    tmpl = MetaTemplate(TYPE_TEMPLATE, tc.TEMPLATE_SUBTYPE_PROMPT, "GreetingPrompt")
    tmpl.set_attr(tc.TEMPLATE_ATTR_TEXT_REF, "tpl/greeting")
    tmpl.set_attr(tc.TEMPLATE_ATTR_FORMAT, tc.TEMPLATE_FORMAT_JSON)
    tmpl.set_attr(tc.TEMPLATE_ATTR_PAYLOAD_REF, "GreetingRequest")
    tmpl.set_attr(tc.TEMPLATE_ATTR_RESPONSE_REF, "GreetingResponse")
    return tmpl


def _greeting_call(base: MetaObject) -> MetaObject:
    entity = MetaObject(TYPE_OBJECT, "entity", "GreetingCall")
    entity.super_data = base  # resolved super chain → _extends_base sees LlmCallBase

    source = MetaSource(TYPE_SOURCE, SOURCE_SUBTYPE_RDB, "primary")
    source.set_attr("table", "llm_call")
    source.set_attr("role", "primary")

    identity = MetaIdentity(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY, "primary")
    identity.set_attr("fields", ["spanId"])

    for child in (source, identity, _prompt()):
        entity.add_child(child)
    return entity


def _root() -> MetaRoot:
    base = _llm_call_base()
    response = _greeting_response()
    request = _value_object(
        "GreetingRequest",
        [_field("prompt", fc.FIELD_SUBTYPE_STRING, **{fc.FIELD_ATTR_REQUIRED: True})],
    )
    call = _greeting_call(base)
    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "test")
    root.package = "metaobjects::ai"
    for c in (base, response, request, call):
        root.add_child(c)
    return root


def _ctx(root: MetaRoot, *, out_dir: str = "/tmp/out") -> GenContext:
    return GenContext(
        entities=[],
        loaded_root=root,
        matches=lambda _e: True,
        config=GenConfig(out_dir=out_dir),
        warn=lambda _m: None,
    )


# ---------------------------------------------------------------------------
# render_trace_helper — text-level shape assertions.
# ---------------------------------------------------------------------------


def _call_entity(root: MetaRoot) -> MetaObject:
    return next(c for c in root.own_children() if c.name == "GreetingCall")


def test_render_emits_record_fn_and_schema_and_persist() -> None:
    root = _root()
    out = render_trace_helper(_call_entity(root), root)
    assert out is not None
    # the typed record_<snake> entry point + result dataclass.
    assert "def record_greeting_call(" in out
    assert "class GreetingCallTraceResult:" in out
    # the baked extract schema (reused via extract_schema_emitter) over the response VO.
    assert "_RESPONSE_SCHEMA" in out
    assert 'ExtractSchema(Format.JSON, "GreetingResponse"' in out
    # Slice-1 row builder + persist + typed columns.
    assert "build_llm_call_row(effective)" in out
    assert "persist_llm_call_row(recorder, row, redact)" in out
    assert 'row["voResponse"] = outcome.data' in out
    assert 'row["voRequest"] = input.llm_request' in out
    # lost-required gate drives status/error_detail.
    assert "outcome.report.has_lost_required()" in out


def test_render_skips_abstract_entity() -> None:
    root = _root()
    base = next(c for c in root.own_children() if c.name == "LlmCallBase")
    assert render_trace_helper(base, root) is None


def test_render_skips_entity_not_extending_base() -> None:
    """A concrete entity with no LlmCallBase super → not a trace target."""
    plain = MetaObject(TYPE_OBJECT, "entity", "Plain")
    plain.add_child(_prompt())
    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "test")
    for c in (_greeting_response(), plain):
        root.add_child(c)
    assert render_trace_helper(plain, root) is None


def test_render_skips_when_no_prompt() -> None:
    base = _llm_call_base()
    entity = MetaObject(TYPE_OBJECT, "entity", "NoPromptCall")
    entity.super_data = base
    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "test")
    for c in (base, entity):
        root.add_child(c)
    assert render_trace_helper(entity, root) is None


def test_render_raises_when_response_ref_unresolvable() -> None:
    base = _llm_call_base()
    tmpl = MetaTemplate(TYPE_TEMPLATE, tc.TEMPLATE_SUBTYPE_PROMPT, "P")
    tmpl.set_attr(tc.TEMPLATE_ATTR_RESPONSE_REF, "DoesNotExist")
    entity = MetaObject(TYPE_OBJECT, "entity", "BadCall")
    entity.super_data = base
    entity.add_child(tmpl)
    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "test")
    for c in (base, entity):
        root.add_child(c)
    with pytest.raises(ValueError, match="does not resolve to an object.value"):
        render_trace_helper(entity, root)


def test_factory_and_generator_name() -> None:
    assert trace_helper_generator().name == "trace-helper"
    assert TraceHelperGenerator().name == "trace-helper"


def test_generator_emits_one_file_per_trace_entity() -> None:
    files = TraceHelperGenerator().generate(_ctx(_root()))
    assert [f.path for f in files] == ["record_greeting_call.py"]


# ---------------------------------------------------------------------------
# Compile-and-run — materialize the emitted module, import it, invoke record_*.
# ---------------------------------------------------------------------------


def _materialize_package(files: list, tmp_path) -> str:
    import os

    pkg_dir = str(tmp_path / "_trace_pkg")
    os.makedirs(pkg_dir, exist_ok=True)
    open(os.path.join(pkg_dir, "__init__.py"), "w").close()
    for f in files:
        with open(os.path.join(pkg_dir, f.path), "w") as fh:
            fh.write(f.content)
    return pkg_dir


def _import_module(pkg_dir: str, module: str, monkeypatch):
    import importlib
    import sys

    parent = pkg_dir.rsplit("/", 1)[0]
    monkeypatch.syspath_prepend(parent)
    for k in list(sys.modules):
        if k == "_trace_pkg" or k.startswith("_trace_pkg."):
            del sys.modules[k]
    importlib.import_module("_trace_pkg")
    return importlib.import_module(f"_trace_pkg.{module}")


def _sample_input(response_text: str) -> LlmCallInput:
    return LlmCallInput(
        span_id="11111111-1111-4111-8111-111111111111",
        trace_id="22222222-2222-4222-8222-222222222222",
        call_type="greeting",
        started_at="2023-11-14T17:13:20+00:00",
        llm_request={"prompt": "say hi"},
        llm_response_text=response_text,
        status="ok",
        error_detail=None,
    )


def test_generated_record_runs_and_returns_ok(tmp_path, monkeypatch) -> None:
    """COMPILE-RUN gate: the emitted module is valid Python and ``record_*`` runs,
    extracting a clean JSON response into the vo_response dict + status ok."""
    files = TraceHelperGenerator().generate(_ctx(_root()))
    pkg_dir = _materialize_package(files, tmp_path)
    mod = _import_module(pkg_dir, "record_greeting_call", monkeypatch)

    inp = _sample_input('{"greeting": "hello", "score": 7}')
    result = mod.record_greeting_call(NullLlmCallRecorder(), inp)

    assert result.status == "ok"
    assert result.error_detail is None
    assert result.vo_response == {"greeting": "hello", "score": 7}


def test_generated_record_reports_error_on_lost_required(tmp_path, monkeypatch) -> None:
    """A response missing the @required ``greeting`` field → status error + a
    lost-required detail (the helper still persists — never aborts)."""
    files = TraceHelperGenerator().generate(_ctx(_root()))
    pkg_dir = _materialize_package(files, tmp_path)
    mod = _import_module(pkg_dir, "record_greeting_call", monkeypatch)

    inp = _sample_input('{"score": 7}')
    result = mod.record_greeting_call(NullLlmCallRecorder(), inp)

    assert result.status == "error"
    assert result.error_detail is not None
    assert "greeting" in result.error_detail
