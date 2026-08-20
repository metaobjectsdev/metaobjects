"""Tests for the response-parser generator (FR-006, re-pointed by ADR-0052).

Mirrors the TS ``output-parser-file.test.ts`` / C# ``OutputParserGeneratorTests``
contracts adapted to Python's single-API throw-only convention: emit a
``parse_<name>(text)`` function returning a typed Pydantic model, raising
``pydantic.ValidationError`` on bad input. No ``safeParseX`` / ``TryParse``
companion — Pydantic is the throw-only ecosystem norm.

ADR-0052 — the tier binds ``@responseRef`` on a ``template.prompt``. Every fixture
here declares a payload ref and a response ref pointing at DIFFERENT value-objects,
so an implementation that bound ``@payloadRef`` (the pre-ADR-0052 behaviour) fails
these tests rather than passing them by coincidence.
"""
from __future__ import annotations

import json

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator import GenContext
from metaobjects.codegen.generators.output_parser_generator import (
    OutputParserGenerator,
    _snake_case,
    output_parser_generator,
    render_output_parser,
)
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.meta.template import template_constants as tc
from metaobjects.meta.template.meta_template import MetaTemplate
from metaobjects.shared.base_types import (
    SUBTYPE_ROOT,
    TYPE_FIELD,
    TYPE_METADATA,
    TYPE_OBJECT,
    TYPE_TEMPLATE,
)


# ---------------------------------------------------------------------------
# Builders — minimal MetaRoot trees for the canonical fixture-style shape.
# ---------------------------------------------------------------------------


def _field(name: str, sub: str, *, required: bool = False) -> MetaField:
    f = MetaField(TYPE_FIELD, sub, name)
    if required:
        f.set_attr(fc.FIELD_ATTR_REQUIRED, True)
    return f


def _payload_vo(name: str, fields: list[MetaField], *, package: str | None = None) -> MetaObject:
    obj = MetaObject(TYPE_OBJECT, "value", name)
    obj.package = package
    for f in fields:
        obj.add_child(f)
    return obj


def _responding_prompt(
    name: str,
    payload_ref: str,
    response_ref: str | None,
    *,
    text_ref: str = "tpl/prompt",
    fmt: str = "text",
    response_format: str | None = None,
) -> MetaTemplate:
    """A ``template.prompt``. *payload_ref* types the request it renders OUTBOUND;
    *response_ref* (when given) types the reply it parses INBOUND. ``@format`` is the
    syntax of the rendered BODY and defaults to ``text`` here deliberately — the
    inbound tier must not read it (ADR-0053)."""
    tmpl = MetaTemplate(TYPE_TEMPLATE, tc.TEMPLATE_SUBTYPE_PROMPT, name)
    tmpl.set_attr(tc.TEMPLATE_ATTR_PAYLOAD_REF, payload_ref)
    if response_ref is not None:
        tmpl.set_attr(tc.TEMPLATE_ATTR_RESPONSE_REF, response_ref)
    if response_format is not None:
        tmpl.set_attr(tc.TEMPLATE_ATTR_RESPONSE_FORMAT, response_format)
    tmpl.set_attr(tc.TEMPLATE_ATTR_TEXT_REF, text_ref)
    tmpl.set_attr(tc.TEMPLATE_ATTR_FORMAT, fmt)
    return tmpl


def _output_template(name: str, payload_ref: str, *, fmt: str = "json") -> MetaTemplate:
    """A ``template.output`` — the OUTBOUND control. ADR-0052: this subtype renders a
    document and generates nothing that reads a model's reply."""
    tmpl = MetaTemplate(TYPE_TEMPLATE, tc.TEMPLATE_SUBTYPE_OUTPUT, name)
    tmpl.set_attr(tc.TEMPLATE_ATTR_PAYLOAD_REF, payload_ref)
    tmpl.set_attr(tc.TEMPLATE_ATTR_TEXT_REF, "tpl/output")
    tmpl.set_attr(tc.TEMPLATE_ATTR_FORMAT, fmt)
    return tmpl


def _root(children: list[MetaObject | MetaTemplate], *, package: str = "acme::ai") -> MetaRoot:
    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "test")
    root.package = package
    for c in children:
        root.add_child(c)
    return root


def _ctx(root: MetaRoot, *, out_dir: str = "/tmp/out") -> GenContext:
    cfg = GenConfig(out_dir=out_dir)
    return GenContext(
        entities=[],
        loaded_root=root,
        matches=lambda _e: True,
        config=cfg,
        warn=lambda _m: None,
    )


def _template(root: MetaRoot, name: str) -> MetaTemplate:
    return next(c for c in root.own_children() if c.name == name)


def _npc_root(*, response_format: str | None = None) -> MetaRoot:
    """A responding prompt whose REQUEST and RESPONSE are different shapes.

    ``NpcBrief`` (the request) and ``NpcAnswer`` (the reply) share no field name, so
    every assertion below discriminates: binding ``@payloadRef`` would produce a
    parser typed on ``mood``, and both the text assertions and the round-trip fail."""
    request = _payload_vo("NpcBrief", [_field("mood", fc.FIELD_SUBTYPE_STRING, required=True)])
    response = _payload_vo(
        "NpcAnswer",
        [
            # @required so the strict Pydantic record keeps them non-optional —
            # the missing-field round-trip below asserts parse raises when absent.
            _field("name", fc.FIELD_SUBTYPE_STRING, required=True),
            _field("age", fc.FIELD_SUBTYPE_INT, required=True),
        ],
    )
    tmpl = _responding_prompt(
        "NpcResponsePrompt", "NpcBrief", "NpcAnswer", response_format=response_format
    )
    return _root([request, response, tmpl])


# ---------------------------------------------------------------------------
# render_output_parser — text-level assertions on the emitted module.
# ---------------------------------------------------------------------------


def test_render_imports_response_and_emits_parse_function() -> None:
    """Parser module imports ``<Name>Response`` from the sibling response module
    and exposes a throw-only ``parse_<name>(text)`` entry point."""
    root = _npc_root()
    out = render_output_parser(_template(root, "NpcResponsePrompt"), root)
    assert out is not None
    # The strict RECORD comes from the sibling response module — no inline Pydantic
    # model. (FR-010 adds a separate nullable mirror dataclass for extract() — see
    # the extract tests below — but the strict record is never inlined.)
    assert "class NpcResponsePromptResponse(" not in out
    assert "from .npc_response_prompt_response import NpcResponsePromptResponse" in out
    assert "def parse_npc_response_prompt(text: str) -> NpcResponsePromptResponse:" in out
    assert "return NpcResponsePromptResponse.model_validate_json(text)" in out
    # ADR-0052 — the REQUEST record is never referenced by the parser.
    assert "NpcResponsePromptPayload" not in out
    assert "npc_response_prompt_payload" not in out


def test_render_includes_generated_header_no_pydantic_import() -> None:
    """Parser module carries the @generated header; pydantic is imported by the
    response module, not the parser module."""
    root = _npc_root()
    out = render_output_parser(_template(root, "NpcResponsePrompt"), root)
    assert out is not None
    assert "@generated by metaobjects" in out
    # Pydantic lives in the record module now.
    assert "from pydantic import BaseModel" not in out


def test_render_returns_none_when_response_ref_unresolved() -> None:
    root = _root([_responding_prompt("StrayPrompt", "DoesNotExist", "AlsoMissing")])
    assert render_output_parser(_template(root, "StrayPrompt"), root) is None


def test_render_returns_none_when_response_ref_attr_missing() -> None:
    """A prompt with a @payloadRef but NO @responseRef renders nothing.

    This is the gate that actually discriminates: @responseRef is prompt-only
    vocabulary the loader already enforces, so the SUBTYPE half of the direction
    rule carries no weight on its own — the ref predicate carries all of it."""
    payload = _payload_vo("NpcBrief", [_field("mood", fc.FIELD_SUBTYPE_STRING)])
    root = _root([payload, _responding_prompt("Naked", "NpcBrief", None)])
    assert render_output_parser(_template(root, "Naked"), root) is None


def test_render_returns_none_when_response_ref_targets_entity_not_value() -> None:
    """``@responseRef`` obeys the SAME target rule as ``@payloadRef`` — an
    ``object.entity`` is not a payload target, so no parser binds it. (C# shipped the
    opposite and emitted a parser returning a record nobody declared: CS0246.)"""
    entity = MetaObject(TYPE_OBJECT, "entity", "Imposter")
    payload = _payload_vo("NpcBrief", [_field("mood", fc.FIELD_SUBTYPE_STRING)])
    root = _root([entity, payload, _responding_prompt("FailingPrompt", "NpcBrief", "Imposter")])
    assert render_output_parser(_template(root, "FailingPrompt"), root) is None


def test_xml_reply_emits_no_strict_parser_but_keeps_the_tolerant_extract() -> None:
    """ADR-0053 — the strict tier is JSON-ONLY. ``model_validate_json`` is an exact
    parser; layering it over the REPAIRING XML reader would raise or accept based on
    how much repair happened."""
    root = _npc_root(response_format=tc.RESPONSE_FORMAT_XML)
    out = render_output_parser(_template(root, "NpcResponsePrompt"), root)
    assert out is not None
    assert "def parse_npc_response_prompt(" not in out
    # ...and the strict record is not imported either, which would be a dead import.
    assert "from .npc_response_prompt_response import" not in out
    assert "def extract_lenient_npc_response_prompt_with_loader(" in out
    assert "Format.XML" in out
    assert '__all__ = ["extract_lenient_npc_response_prompt_with_loader"' in out


def test_a_text_bodied_prompt_still_gets_the_json_strict_tier() -> None:
    """The reply's syntax is ``@responseFormat``, never ``@format``. ``_npc_root``
    declares ``@format: text`` — a prompt BODY is prose — and no ``@responseFormat``,
    so the reply defaults to JSON and the strict tier is emitted. Reading ``@format``
    here is what made a text-bodied prompt asking for a JSON answer emit nothing."""
    root = _npc_root()
    out = render_output_parser(_template(root, "NpcResponsePrompt"), root)
    assert out is not None
    assert "def parse_npc_response_prompt(" in out
    assert "Format.JSON" in out


# ---------------------------------------------------------------------------
# Generator — wraps render + iterates root for every responding template.prompt.
# ---------------------------------------------------------------------------


def test_generator_emits_one_file_per_responding_prompt() -> None:
    payload_a = _payload_vo("BriefA", [_field("mood", fc.FIELD_SUBTYPE_STRING)])
    payload_b = _payload_vo("BriefB", [_field("mood", fc.FIELD_SUBTYPE_STRING)])
    answer_a = _payload_vo("AnswerA", [_field("name", fc.FIELD_SUBTYPE_STRING)])
    answer_b = _payload_vo("AnswerB", [_field("count", fc.FIELD_SUBTYPE_INT)])
    tmpl_a = _responding_prompt("AlphaPrompt", "BriefA", "AnswerA")
    tmpl_b = _responding_prompt("BetaPrompt", "BriefB", "AnswerB")
    root = _root([payload_a, payload_b, answer_a, answer_b, tmpl_a, tmpl_b])

    files = OutputParserGenerator().generate(_ctx(root))
    paths = [f.path for f in files]
    assert paths == ["alpha_prompt_response_parser.py", "beta_prompt_response_parser.py"]


def test_generator_skips_unresolved_and_warns() -> None:
    root = _root([_responding_prompt("StrayPrompt", "DoesNotExist", "AlsoMissing")])
    warnings: list[str] = []
    ctx = GenContext(
        entities=[],
        loaded_root=root,
        matches=lambda _e: True,
        config=GenConfig(out_dir="/tmp/out"),
        warn=warnings.append,
    )
    files = OutputParserGenerator().generate(ctx)
    assert files == []
    assert any("StrayPrompt" in w for w in warnings)


def test_generator_ignores_template_output() -> None:
    """The OUTBOUND control. A ``template.output`` renders a document; nothing reads a
    reply back off it, so it gets no parser however its ``@format`` reads."""
    payload = _payload_vo("Payload", [_field("name", fc.FIELD_SUBTYPE_STRING)])
    root = _root([payload, _output_template("ReceiptOutput", "Payload")])
    assert OutputParserGenerator().generate(_ctx(root)) == []


def test_generator_ignores_a_prompt_with_no_response_ref() -> None:
    payload = _payload_vo("Payload", [_field("name", fc.FIELD_SUBTYPE_STRING)])
    root = _root([payload, _responding_prompt("Greet", "Payload", None)])
    assert OutputParserGenerator().generate(_ctx(root)) == []


def test_factory_returns_generator_with_expected_name() -> None:
    gen = output_parser_generator()
    assert gen.name == "output-parser-generator"


# ---------------------------------------------------------------------------
# Round-trip — execute the emitted parser+record pair as a package and verify
# Pydantic-shape behavior end-to-end. The parser module does ``from .<record>
# import …``, so we need a real package on the filesystem (not a string exec).
# ---------------------------------------------------------------------------


def _materialize_package(files: list, payload_files: list, tmp_path) -> tuple[str, list[str]]:
    """Write *files* + *payload_files* into a real Python package under *tmp_path*
    and return ``(package_dir, modules_relative_to_package)``."""
    import os

    pkg_dir = str(tmp_path / "_gen_pkg")
    os.makedirs(pkg_dir, exist_ok=True)
    open(os.path.join(pkg_dir, "__init__.py"), "w").close()
    module_names: list[str] = []
    for f in [*payload_files, *files]:
        with open(os.path.join(pkg_dir, f.path), "w") as fh:
            fh.write(f.content)
        module_names.append(f.path[:-3])  # strip .py
    return pkg_dir, module_names


def _import_package(pkg_dir: str, monkeypatch) -> object:
    """Import the materialized package and return it."""
    import importlib
    import sys

    parent = pkg_dir.rsplit("/", 1)[0]
    monkeypatch.syspath_prepend(parent)
    # Drop any prior import cache for this throwaway package name.
    for k in list(sys.modules):
        if k == "_gen_pkg" or k.startswith("_gen_pkg."):
            del sys.modules[k]
    return importlib.import_module("_gen_pkg")


def _parser_module(tmp_path, monkeypatch):
    from importlib import import_module

    from metaobjects.codegen.generators.payload_vo_generator import PayloadVoGenerator

    root = _npc_root()
    parser_files = OutputParserGenerator().generate(_ctx(root))
    payload_files = PayloadVoGenerator().generate(_ctx(root))
    assert len(parser_files) == 1
    pkg_dir, _ = _materialize_package(parser_files, payload_files, tmp_path)
    _import_package(pkg_dir, monkeypatch)
    return import_module("_gen_pkg.npc_response_prompt_response_parser")


def test_emitted_module_parses_the_response_shape(tmp_path, monkeypatch) -> None:
    parser_mod = _parser_module(tmp_path, monkeypatch)
    result = parser_mod.parse_npc_response_prompt(json.dumps({"name": "Igor", "age": 42}))
    assert result.name == "Igor"
    assert result.age == 42


def test_emitted_module_rejects_the_request_shape(tmp_path, monkeypatch) -> None:
    """The discriminating round-trip: ``NpcBrief`` (the ``@payloadRef`` request) is a
    valid document that this parser must REFUSE, because it parses ``NpcAnswer``."""
    from pydantic import ValidationError

    parser_mod = _parser_module(tmp_path, monkeypatch)
    try:
        parser_mod.parse_npc_response_prompt(json.dumps({"mood": "grumpy"}))
    except ValidationError:
        return
    raise AssertionError("Expected ValidationError — the request shape is not the reply shape")


def test_emitted_module_raises_validation_error_on_bad_payload(tmp_path, monkeypatch) -> None:
    from pydantic import ValidationError

    parser_mod = _parser_module(tmp_path, monkeypatch)
    try:
        parser_mod.parse_npc_response_prompt(json.dumps({"name": "Igor", "age": "forty-two"}))
    except ValidationError:
        return
    raise AssertionError("Expected ValidationError for non-int age")


def test_emitted_module_raises_on_missing_field(tmp_path, monkeypatch) -> None:
    from pydantic import ValidationError

    parser_mod = _parser_module(tmp_path, monkeypatch)
    try:
        parser_mod.parse_npc_response_prompt(json.dumps({"name": "Igor"}))
    except ValidationError:
        return
    raise AssertionError("Expected ValidationError for missing 'age'")


# ---------------------------------------------------------------------------
# Snake-case helper — same shape as the router_generator's local helper.
# ---------------------------------------------------------------------------


def test_snake_case_pascal_to_snake() -> None:
    assert _snake_case("NpcResponseOutput") == "npc_response_output"
    assert _snake_case("Alpha") == "alpha"
    assert _snake_case("ABC") == "a_b_c"
