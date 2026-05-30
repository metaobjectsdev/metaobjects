"""FR-010 artifact 1 — output-format prompt renderer ("produce your answer like this").

Renders an :class:`OutputFormatSpec` into a prompt fragment that teaches an LLM how
to shape its answer. Three comment-free styles (guide / inline / exampleOnly) × two
formats (json / xml). Guidance is carried in prose / inline placeholders / a filled
skeleton — NEVER in comments (models ignore them).

Cross-port INVARIANT: the rendered text is byte-identical to the Java/C#/Kotlin/TS
reference (``com.metaobjects.render.prompt.OutputFormatRenderer``). Do not change the
verbatim prose, skeleton shapes, or the numeric-vs-quoted decision.
"""
from __future__ import annotations

import re

import metaobjects.render.escapers as escapers
from metaobjects.render.prompt.output_format_spec import OutputFormatSpec
from metaobjects.render.prompt.prompt_field import PromptField
from metaobjects.render.prompt.prompt_overrides import PromptOverrides
from metaobjects.render.prompt.prompt_style import PromptStyle
from metaobjects.render.recover import FieldKind, Format

_NUMERIC_KINDS: frozenset[FieldKind] = frozenset(
    {FieldKind.INT, FieldKind.LONG, FieldKind.DOUBLE, FieldKind.BOOLEAN}
)

# The render engine OWNS format-keyed escaping; the Format enum's UPPER values
# ("JSON"/"XML") map to the lowercase escaper-registry keys.
def _escape_xml(s: str) -> str:
    return escapers.escape(escapers.FORMAT_XML, s)


def _escape_json(s: str) -> str:
    return escapers.escape(escapers.FORMAT_JSON, s)


def render_output_format(spec: OutputFormatSpec, overrides: PromptOverrides) -> str:
    """Render an :class:`OutputFormatSpec` into an output-format prompt fragment.

    The effective style is the override's style if present, otherwise the spec's.
    """
    effective_style = overrides.style if overrides.style is not None else spec.style
    if effective_style is PromptStyle.EXAMPLE_ONLY:
        return _render_example_only(spec, overrides)
    if effective_style is PromptStyle.INLINE:
        return _render_inline(spec, overrides)
    return _render_guide(spec, overrides)


# ---- INLINE ----------------------------------------------------------------


def _render_inline(spec: OutputFormatSpec, overrides: PromptOverrides) -> str:
    if spec.format is Format.XML:
        return _render_xml_inline(spec, overrides)
    return _render_json_inline(spec, overrides)


def _render_xml_inline(spec: OutputFormatSpec, overrides: PromptOverrides) -> str:
    lines = [
        f"  <{f.name}>{_escape_xml(_inline_content(f, overrides))}</{f.name}>\n"
        for f in spec.fields
    ]
    return f"<{spec.root_name}>\n{''.join(lines)}</{spec.root_name}>"


def _render_json_inline(spec: OutputFormatSpec, overrides: PromptOverrides) -> str:
    lines = [
        f'  "{f.name}": "{_escape_json(_inline_content(f, overrides))}"'
        for f in spec.fields
    ]
    # Empty object is `{\n}` (cross-port parity), not `{\n\n}`.
    if not lines:
        return "{\n}"
    return "{\n" + ",\n".join(lines) + "\n}"


def _inline_content(field: PromptField, overrides: PromptOverrides) -> str:
    if field.kind is FieldKind.ENUM and field.enum_values:
        return " | ".join(field.enum_values)
    if field.kind is FieldKind.BOOLEAN:
        return "true | false"
    instruction = _resolve_instruction(field, overrides)
    if instruction is not None:
        return "{" + instruction + "}"
    return "{" + field.name + "}"


def _resolve_instruction(field: PromptField, overrides: PromptOverrides) -> str | None:
    """Effective instruction: override first, then the field default, else None."""
    ov = overrides.instructions.get(field.name)
    if ov is not None:
        return ov
    return field.instruction


# ---- GUIDE -----------------------------------------------------------------


def _render_guide(spec: OutputFormatSpec, overrides: PromptOverrides) -> str:
    sb = "Fill in each field as described below:\n"
    for field in spec.fields:
        req = "required" if field.required else "optional"
        sb += f"- {field.name} ({req})"
        instruction = _resolve_instruction(field, overrides)
        if instruction is not None:
            sb += f": {instruction}"
        sb += "\n"
        if field.kind is FieldKind.ENUM and field.enum_values:
            sb += f"    one of {', '.join(field.enum_values)}\n"
            enum_doc = field.enum_doc
            if enum_doc is not None:
                for val in field.enum_values:
                    doc = enum_doc.get(val)
                    if doc is not None:
                        sb += f"      {val} = {doc}\n"
        eg = _example_value_if_declared(field, overrides)
        if eg is not None:
            sb += f"    e.g. {eg}\n"
    sb += "\nRespond exactly like this:\n"
    sb += _render_example_only(spec, overrides)
    return sb


# ---- EXAMPLE-ONLY (also the skeleton appended by GUIDE) ---------------------


def _render_example_only(spec: OutputFormatSpec, overrides: PromptOverrides) -> str:
    if spec.format is Format.XML:
        return _render_xml_skeleton(spec, overrides)
    return _render_json_skeleton(spec, overrides)


def _render_xml_skeleton(spec: OutputFormatSpec, overrides: PromptOverrides) -> str:
    lines = [
        f"  <{f.name}>{_escape_xml(_example_value(f, overrides))}</{f.name}>\n"
        for f in spec.fields
    ]
    return f"<{spec.root_name}>\n{''.join(lines)}</{spec.root_name}>"


def _render_json_skeleton(spec: OutputFormatSpec, overrides: PromptOverrides) -> str:
    # NOTE: FieldKind.OBJECT / nested fields are not expanded here — they render as a
    # "{fieldName}" placeholder. Nested-object expansion is a bounded deferral
    # (mirrors Java/C#/TS).
    lines = [
        f'  "{f.name}": {_json_skeleton_value(f, overrides)}' for f in spec.fields
    ]
    # Empty object is `{\n}` (cross-port parity), not `{\n\n}`.
    if not lines:
        return "{\n}"
    return "{\n" + ",\n".join(lines) + "\n}"


def _json_skeleton_value(field: PromptField, overrides: PromptOverrides) -> str:
    """The example value as a JSON literal: bare for numeric/boolean, else quoted."""
    value = _example_value(field, overrides)
    if _is_numeric_or_boolean(field.kind, value):
        return value
    return '"' + _escape_json(value) + '"'


def _example_value_if_declared(field: PromptField, overrides: PromptOverrides) -> str | None:
    from_override = overrides.examples.get(field.name)
    if from_override is not None:
        return from_override
    if field.example is not None:
        return field.example
    return None


def _example_value(field: PromptField, overrides: PromptOverrides) -> str:
    from_override = overrides.examples.get(field.name)
    if from_override is not None:
        return from_override
    if field.example is not None:
        return field.example
    if field.kind is FieldKind.ENUM and field.enum_values:
        return field.enum_values[0]
    return "{" + field.name + "}"


# A canonical ASCII numeric literal. Mirrors the recover engine's `_ASCII_NUMERIC`:
# `[0-9]` (not `\d`) keeps it ASCII-only, rejecting Unicode digits, underscore digit
# grouping, and radix prefixes (0x../0b../0o..) so the emitted JSON stays valid and
# cross-port-identical.
_ASCII_NUMERIC = re.compile(r"^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$")


def _is_numeric_or_boolean(kind: FieldKind, value: str) -> bool:
    if kind not in _NUMERIC_KINDS:
        return False
    if value in ("true", "false"):
        return True
    return bool(_ASCII_NUMERIC.match(value.strip()))
