"""Turns a payload value-object + its ``template.output`` node into a Python source
literal for an :class:`~metaobjects.render.OutputFormatSpec` — the artifact-1 prompt
descriptor used by the FR-010 output-prompt codegen.

Emits ``OutputFormatSpec(Format.X, "rootName", PromptStyle.X, [PromptField(...), …])``.
Mirrors the C# / Java ``OutputFormatSpecEmitter`` adapted to Python (keyword args for
the long ``PromptField`` ctor to keep the emitted source readable + order-robust).
Bounded scope: scalar / enum. Nested object → ``FieldKind.OBJECT`` placeholder.
"""
from __future__ import annotations

from metaobjects.codegen import fr010_field_mapping as fm
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.template import template_constants as tc


def _format_enum(template: MetaData) -> str:
    fmt = template.attr(tc.TEMPLATE_ATTR_FORMAT)
    return (
        "Format.XML"
        if isinstance(fmt, str) and fmt.lower() == "xml"
        else "Format.JSON"
    )


def _prompt_style_enum(template: MetaData) -> str:
    style = template.attr(tc.TEMPLATE_ATTR_PROMPT_STYLE)
    if style == tc.PROMPT_STYLE_INLINE:
        return "PromptStyle.INLINE"
    if style == tc.PROMPT_STYLE_EXAMPLE_ONLY:
        return "PromptStyle.EXAMPLE_ONLY"
    return "PromptStyle.GUIDE"


def _opt_string_attr(field: MetaData, attr_name: str) -> str:
    v = field.attrs().get(attr_name)
    return fm.py_string_literal(v) if isinstance(v, str) else "None"


def _prompt_field_literal(field: MetaData) -> str:
    name = field.name
    req = "True" if fm.is_required(field) else "False"
    array = "True" if fm.is_array(field) else "False"

    if field.sub_type == fc.FIELD_SUBTYPE_OBJECT:
        return (
            f'PromptField("{name}", FieldKind.OBJECT, {req}, array={array})'
            "  # FR-010: nested prompt deferred"
        )

    example = _opt_string_attr(field, fc.FIELD_ATTR_EXAMPLE)
    instruction = _opt_string_attr(field, fc.FIELD_ATTR_INSTRUCTION)

    if field.sub_type == fc.FIELD_SUBTYPE_ENUM:
        values_lit = fm.string_list_literal(fm.enum_values(field))
        enum_doc_lit = fm.properties_map_literal(field.attrs().get(fc.FIELD_ATTR_ENUM_DOC))
        return (
            f'PromptField("{name}", FieldKind.ENUM, {req}, array={array}, '
            f"enum_values={values_lit}, enum_doc={enum_doc_lit}, "
            f"example={example}, instruction={instruction})"
        )

    kind = fm.scalar_kind(field.sub_type) or "STRING"
    return (
        f'PromptField("{name}", FieldKind.{kind}, {req}, array={array}, '
        f"example={example}, instruction={instruction})"
    )


def spec_literal(vo: MetaData, template: MetaData, root_name: str) -> str:
    """Emit ``OutputFormatSpec(Format.X, "rootName", PromptStyle.X, [PromptField(...), …])``."""
    format_enum = _format_enum(template)
    style_enum = _prompt_style_enum(template)
    field_lits = [_prompt_field_literal(f) for f in fm.fields(vo)]
    body = ", ".join(field_lits)
    return (
        f'OutputFormatSpec({format_enum}, "{root_name}", {style_enum}, [{body}])'
    )
