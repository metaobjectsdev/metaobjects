"""Turns a response value-object + its ``template.prompt`` node into a Python source
literal for an :class:`~metaobjects.render.OutputFormatSpec` — the artifact-1 prompt
descriptor used by the FR-010 response-format codegen.

Emits ``OutputFormatSpec(Format.X, "rootName", PromptStyle.X, [PromptField(...), …])``.
Mirrors the C# / Java ``OutputFormatSpecEmitter`` adapted to Python (keyword args for
the long ``PromptField`` ctor to keep the emitted source readable + order-robust).
Bounded scope: scalar / enum. Nested object → ``FieldKind.OBJECT`` placeholder.
"""
from __future__ import annotations

from . import fr010_field_mapping as fm
from metaobjects.codegen.writer import Piece, call, flat, kwarg, seq
from metaobjects.codegen.generators.find_inbound import is_xml, response_format_of
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.template import template_constants as tc


def _format_enum(template: MetaData) -> str:
    """ADR-0053 — the fragment describes the REPLY, so its syntax is ``@responseFormat``,
    NOT ``@format``, which is the syntax of the rendered prompt BODY. Reading ``@format``
    here typed the instruction "produce your answer like this" off the format of the
    QUESTION."""
    return "Format.XML" if is_xml(response_format_of(template)) else "Format.JSON"


def _prompt_style_enum(template: MetaData) -> str:
    style = template.get_meta_attr(tc.TEMPLATE_ATTR_PROMPT_STYLE)  # ADR-0039: template attr resolves via extends (not origin; templates CAN extend)
    if style == tc.PROMPT_STYLE_INLINE:
        return "PromptStyle.INLINE"
    if style == tc.PROMPT_STYLE_EXAMPLE_ONLY:
        return "PromptStyle.EXAMPLE_ONLY"
    return "PromptStyle.GUIDE"


def _opt_string_attr(field: MetaData, attr_name: str) -> str:
    v = field.attrs().get(attr_name)
    return fm.py_string_literal(v) if isinstance(v, str) else "None"


def _prompt_field_piece(field: MetaData) -> Piece:
    name = field.name
    req = "True" if fm.is_required(field) else "False"
    array = "True" if fm.is_array(field) else "False"

    if field.sub_type == fc.FIELD_SUBTYPE_OBJECT:
        # FR-010: nested prompt deferred — emit a FieldKind.OBJECT placeholder (nested
        # defaults to None on PromptField). The note lives HERE, not in the returned
        # literal: a Python '#' inline comment would swallow the rest of its line,
        # including a closing bracket, so the literal must carry no comment. The other
        # ports use `/* */` block comments, which are inline-safe; Python has none.
        return call(
            "PromptField", [f'"{name}"', "FieldKind.OBJECT", req, kwarg("array", array)]
        )

    example = _opt_string_attr(field, fc.FIELD_ATTR_EXAMPLE)
    instruction = _opt_string_attr(field, fc.FIELD_ATTR_INSTRUCTION)

    if field.sub_type == fc.FIELD_SUBTYPE_ENUM:
        values_lit = fm.string_list_literal(fm.enum_values(field))
        enum_doc_lit = fm.properties_map_literal(field.attrs().get(fc.FIELD_ATTR_ENUM_DOC))
        return call(
            "PromptField",
            [
                f'"{name}"', "FieldKind.ENUM", req, kwarg("array", array),
                kwarg("enum_values", values_lit), kwarg("enum_doc", enum_doc_lit),
                kwarg("example", example), kwarg("instruction", instruction),
            ],
        )

    kind = fm.scalar_kind(field.sub_type) or "STRING"
    return call(
        "PromptField",
        [
            f'"{name}"', f"FieldKind.{kind}", req, kwarg("array", array),
            kwarg("example", example), kwarg("instruction", instruction),
        ],
    )


def spec_piece(vo: MetaData, template: MetaData, root_name: str) -> Piece:
    """The ``OutputFormatSpec(...)`` literal as a writer piece: a generator on
    :class:`~metaobjects.codegen.writer.PyWriter` writes it, and it breaks one field per
    line when it does not fit."""
    return call(
        "OutputFormatSpec",
        [
            _format_enum(template),
            f'"{root_name}"',
            _prompt_style_enum(template),
            seq([_prompt_field_piece(f) for f in fm.fields(vo)]),
        ],
    )


def spec_literal(vo: MetaData, template: MetaData, root_name: str) -> str:
    """Emit ``OutputFormatSpec(Format.X, "rootName", PromptStyle.X, [PromptField(...), …])``
    on one line. The string form an owned generator's extension seam returns."""
    return flat(spec_piece(vo, template, root_name))
