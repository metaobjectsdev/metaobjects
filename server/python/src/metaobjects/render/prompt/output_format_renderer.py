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

_INDENT = "  "
_MAX_NEST_DEPTH = 8

# Render mode shared by the example/inline skeleton recursion.
_MODE_EXAMPLE = "example"
_MODE_INLINE = "inline"

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
        return _render_xml_skeleton(spec, overrides, _MODE_INLINE)
    return _render_json_skeleton(spec, overrides, _MODE_INLINE)


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
    sb += _guide_fields(spec, overrides, "", {id(spec)}, 0)
    sb += "\nRespond exactly like this:\n"
    sb += _render_example_only(spec, overrides)
    return sb


def _guide_fields(
    spec: OutputFormatSpec,
    overrides: PromptOverrides,
    prefix: str,
    path: set[int],
    depth: int,
) -> str:
    sb = ""
    for field in spec.fields:
        display_name = prefix + field.name
        sb += _guide_entry(field, overrides, display_name)
        if _can_expand(field, path, depth):
            nested = field.nested
            assert nested is not None
            child_prefix = (
                f"{display_name}[]." if field.array else f"{display_name}."
            )
            path.add(id(nested))
            sb += _guide_fields(nested, overrides, child_prefix, path, depth + 1)
            path.discard(id(nested))
    return sb


def _guide_entry(
    field: PromptField, overrides: PromptOverrides, display_name: str
) -> str:
    req = "required" if field.required else "optional"
    sb = f"- {display_name} ({req})"
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
    return sb


# ---- EXAMPLE-ONLY (also the skeleton appended by GUIDE) ---------------------


def _render_example_only(spec: OutputFormatSpec, overrides: PromptOverrides) -> str:
    if spec.format is Format.XML:
        return _render_xml_skeleton(spec, overrides, _MODE_EXAMPLE)
    return _render_json_skeleton(spec, overrides, _MODE_EXAMPLE)


# ---- JSON skeleton (recursive) ---------------------------------------------


def _render_json_skeleton(
    spec: OutputFormatSpec, overrides: PromptOverrides, mode: str
) -> str:
    return _json_object(spec, overrides, "", mode, {id(spec)}, 0)


def _json_object(
    spec: OutputFormatSpec,
    overrides: PromptOverrides,
    brace_indent: str,
    mode: str,
    path: set[int],
    depth: int,
) -> str:
    # Empty object is `{\n<brace_indent>}` (cross-port parity), not `{\n\n}`.
    if not spec.fields:
        return f"{{\n{brace_indent}}}"
    field_indent = brace_indent + _INDENT
    lines = [
        f'{field_indent}"{field.name}": '
        f"{_json_value(field, overrides, field_indent, mode, path, depth)}"
        for field in spec.fields
    ]
    return "{\n" + ",\n".join(lines) + f"\n{brace_indent}}}"


def _json_value(
    field: PromptField,
    overrides: PromptOverrides,
    indent: str,
    mode: str,
    path: set[int],
    depth: int,
) -> str:
    if field.array:
        return _json_array(field, overrides, indent, mode, path, depth)
    if field.kind is FieldKind.OBJECT:
        return _json_object_field(field, overrides, indent, mode, path, depth)
    return _json_leaf(field, overrides, mode)


def _json_leaf(field: PromptField, overrides: PromptOverrides, mode: str) -> str:
    if mode == _MODE_INLINE:
        return '"' + _escape_json(_inline_content(field, overrides)) + '"'
    value = _example_value(field, overrides)
    if _is_numeric_or_boolean(field.kind, value):
        return value
    return '"' + _escape_json(value) + '"'


def _json_object_field(
    field: PromptField,
    overrides: PromptOverrides,
    indent: str,
    mode: str,
    path: set[int],
    depth: int,
) -> str:
    if not _can_expand(field, path, depth):
        return _json_leaf(field, overrides, mode)
    nested = field.nested
    assert nested is not None
    path.add(id(nested))
    out = _json_object(nested, overrides, indent, mode, path, depth + 1)
    path.discard(id(nested))
    return out


def _json_array(
    field: PromptField,
    overrides: PromptOverrides,
    indent: str,
    mode: str,
    path: set[int],
    depth: int,
) -> str:
    elem_indent = indent + _INDENT
    if _can_expand(field, path, depth):
        nested = field.nested
        assert nested is not None
        path.add(id(nested))
        elem = _json_object(nested, overrides, elem_indent, mode, path, depth + 1)
        path.discard(id(nested))
    else:
        elem = _json_leaf(field, overrides, mode)
    return f"[\n{elem_indent}{elem}\n{indent}]"


# ---- XML skeleton (recursive) ----------------------------------------------


def _render_xml_skeleton(
    spec: OutputFormatSpec, overrides: PromptOverrides, mode: str
) -> str:
    body = _xml_body(spec, overrides, _INDENT, mode, {id(spec)}, 0)
    return f"<{spec.root_name}>\n{body}</{spec.root_name}>"


def _xml_body(
    spec: OutputFormatSpec,
    overrides: PromptOverrides,
    indent: str,
    mode: str,
    path: set[int],
    depth: int,
) -> str:
    return "".join(
        _xml_field(field, overrides, indent, mode, path, depth)
        for field in spec.fields
    )


def _xml_field(
    field: PromptField,
    overrides: PromptOverrides,
    indent: str,
    mode: str,
    path: set[int],
    depth: int,
) -> str:
    if _can_expand(field, path, depth):
        nested = field.nested
        assert nested is not None
        path.add(id(nested))
        body = _xml_body(nested, overrides, indent + _INDENT, mode, path, depth + 1)
        path.discard(id(nested))
        return f"{indent}<{field.name}>\n{body}{indent}</{field.name}>\n"
    content = (
        _inline_content(field, overrides)
        if mode == _MODE_INLINE
        else _example_value(field, overrides)
    )
    return f"{indent}<{field.name}>{_escape_xml(content)}</{field.name}>\n"


# ---- nested-expansion guard ------------------------------------------------


def _can_expand(field: PromptField, path: set[int], depth: int) -> bool:
    """Expand an OBJECT field only when it has a nested spec, the depth bound is not
    exceeded, and it would not re-enter a spec already on the current path.

    The cycle guard is REFERENCE IDENTITY via ``id()``: frozen dataclasses compare by
    value (``eq=True``), so two value-equal sibling specs must both still expand. ``id``
    keys distinguish them.
    """
    return (
        field.kind is FieldKind.OBJECT
        and field.nested is not None
        and depth < _MAX_NEST_DEPTH
        and id(field.nested) not in path
    )


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
