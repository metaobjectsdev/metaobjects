"""Regression: a ``template.output`` payload with a NESTED ``field.object`` must emit
VALID Python from the output-prompt spec emitter (a ``FieldKind.OBJECT`` placeholder),
NOT crash ``gen`` / ``verify --codegen``.

The bug (0.15.0): the nested-object branch appended an inline ``# FR-010: nested prompt
deferred`` comment to the emitted literal. ``spec_literal`` joins every field onto ONE
line, so the Python ``#`` swallowed the rest of the line — including the closing ``])`` —
producing an unterminated list (``SyntaxError: '[' was never closed``). The other four
ports use ``/* */`` block comments, which are inline-safe; Python has none, so the literal
must carry no comment.
"""
from __future__ import annotations

import ast

import metaobjects.core_types  # noqa: F401 — side-effect: registers attr classes
from metaobjects.codegen import output_format_spec_emitter as ofs
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.template import template_constants as tc
from metaobjects.meta.template.meta_template import MetaTemplate
from metaobjects.shared.base_types import TYPE_FIELD, TYPE_OBJECT, TYPE_TEMPLATE


def _envelope() -> tuple[MetaObject, MetaTemplate]:
    before = MetaField(TYPE_FIELD, fc.FIELD_SUBTYPE_STRING, "before")
    before.set_attr(fc.FIELD_ATTR_REQUIRED, True)
    # the nested object sits BETWEEN two scalars, so a swallowed line would eat both the
    # trailing field and the closing bracket.
    inner = MetaField(TYPE_FIELD, fc.FIELD_SUBTYPE_OBJECT, "inner")
    inner.set_attr(fc.FIELD_ATTR_REQUIRED, True)
    after = MetaField(TYPE_FIELD, fc.FIELD_SUBTYPE_STRING, "after")

    vo = MetaObject(TYPE_OBJECT, "value", "Envelope")
    vo.package = "acme::ai"
    for f in (before, inner, after):
        vo.add_child(f)

    tmpl = MetaTemplate(TYPE_TEMPLATE, tc.TEMPLATE_SUBTYPE_OUTPUT, "EnvOutput")
    tmpl.set_attr(tc.TEMPLATE_ATTR_PAYLOAD_REF, "Envelope")
    tmpl.set_attr(tc.TEMPLATE_ATTR_FORMAT, "xml")
    tmpl.set_attr(tc.TEMPLATE_ATTR_PROMPT_STYLE, "guide")
    return vo, tmpl


def test_nested_object_payload_emits_parseable_python() -> None:
    vo, tmpl = _envelope()
    lit = ofs.spec_literal(vo, tmpl, "Envelope")

    # 1) the whole OutputFormatSpec(...) literal must be valid Python — the core bug.
    ast.parse(lit)  # raised "SyntaxError: '[' was never closed" on the broken output

    # 2) the nested field is a FieldKind.OBJECT placeholder …
    assert "FieldKind.OBJECT" in lit
    # 3) … with NO inline comment in the emitted literal (that was the swallow) …
    assert "#" not in lit
    # 4) … and the field AFTER the nested one survived (was not commented out).
    assert '"after"' in lit
