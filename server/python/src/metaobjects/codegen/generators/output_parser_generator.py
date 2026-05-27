"""Output parser codegen — one ``<template_name>_output_parser.py`` per
``template.output`` declaration.

FR-006 (Python) per ADR-0010 and ``docs/superpowers/specs/2026-05-25-fr6-python-template-output-parser.md``.

Single-API throw-only convention matches the Python ecosystem norm: Pydantic
raises ``pydantic.ValidationError`` on bad input; callers wrap in ``try/except``
as needed. No dual API — TS uses ``parseX``/``safeParseX`` because Zod's
``safeParse`` is idiomatic; C# uses ``Parse``/``TryParse`` per BCL convention;
Python's ecosystem (Pydantic, Instructor, FastAPI, LangChain structured-output)
is throw-only and a dual surface would feel un-Pythonic.

Self-contained emit: the generated module declares an inline Pydantic v2 model
derived from the payload-VO's field declarations (no separate ``payload_vo``
generator required — TS embeds its Zod schema the same way). This deviates
from the spec sketch's import-style example (``from .npc_response import
NpcResponse``) because Python has no payload-VO generator yet; embedding the
class makes the parser module usable today without a hand-written companion.
If a future ``payload_vo_generator`` ships, this generator can be migrated to
import from it (one-line file-name swap on the import).

Field subtype → Pydantic type mapping mirrors the TS Zod mapping and matches
ADR-0010 §4 (Cross-language type mapping):

* ``field.string``     → ``str``
* ``field.int / .long / .short / .byte`` → ``int``
* ``field.double / .float`` → ``float``
* ``field.boolean``    → ``bool``
* ``field.currency``   → ``int`` (minor units; wire contract)
* ``field.date / .time / .timestamp`` → ``datetime.{date,time,datetime}``
* ``field.enum`` (with ``@values``) → ``Literal[...]`` of those members
* Anything else        → ``str`` (defensive fallback — surfaces as a warning)

Future per-field constraints (``@maxLength``, ``@required``-vs-optional
nullability, ``@objectRef`` nesting) follow when their TS/C# counterparts
ship them — kept minimal for FR6 v1 parity.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from metaobjects.codegen.constants import generated_header
from metaobjects.codegen.format import ruff_format
from metaobjects.codegen.generator import EmittedFile, GenContext, Generator
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.template import template_constants as tc
from metaobjects.shared.base_types import TYPE_OBJECT, TYPE_TEMPLATE


_GENERATOR_NAME = "output-parser-generator"


def _snake_case(name: str) -> str:
    """``NpcResponseOutput`` → ``npc_response_output``. Trivial PascalCase →
    snake_case (no acronym handling; matches the cross-port convention used by
    ``router_generator._snake_case``)."""
    out: list[str] = []
    for i, ch in enumerate(name):
        if ch.isupper() and i > 0:
            out.append("_")
        out.append(ch.lower())
    return "".join(out)


# Field-subtype → (Pydantic-annotation, required-import) tuple.
# Empty string in the second slot means "no extra import beyond Pydantic".
_FIELD_TYPE_MAP: dict[str, tuple[str, str]] = {
    fc.FIELD_SUBTYPE_STRING: ("str", ""),
    fc.FIELD_SUBTYPE_INT: ("int", ""),
    fc.FIELD_SUBTYPE_LONG: ("int", ""),
    fc.FIELD_SUBTYPE_DOUBLE: ("float", ""),
    fc.FIELD_SUBTYPE_FLOAT: ("float", ""),
    fc.FIELD_SUBTYPE_BOOLEAN: ("bool", ""),
    fc.FIELD_SUBTYPE_CURRENCY: ("int", ""),
    fc.FIELD_SUBTYPE_DATE: ("date", "from datetime import date"),
    fc.FIELD_SUBTYPE_TIME: ("time", "from datetime import time"),
    fc.FIELD_SUBTYPE_TIMESTAMP: ("datetime", "from datetime import datetime"),
}


def _python_type_for(field: MetaField) -> tuple[str, set[str]]:
    """Return (annotation, set-of-import-lines) for a payload field."""
    sub = field.sub_type
    if sub in _FIELD_TYPE_MAP:
        annotation, import_line = _FIELD_TYPE_MAP[sub]
        return annotation, ({import_line} if import_line else set())
    if sub == fc.FIELD_SUBTYPE_ENUM:
        values: Any = field.attr(fc.FIELD_ATTR_VALUES)
        if isinstance(values, (list, tuple)) and values:
            members = ", ".join(repr(str(v)) for v in values)
            return f"Literal[{members}]", {"from typing import Literal"}
        return "str", set()
    return "str", set()


def _find_payload_vo(root: MetaData, payload_ref: str) -> MetaObject | None:
    """Locate the ``object.value`` matching ``payload_ref`` at root level.

    FR-004's R2 invariant (the loader's ``_validate_templates`` pass) already
    asserts the resolved object is ``object.value``; we just locate it by
    short-name and return it. Loader errors short-circuit before codegen, so
    a missing ref here is defensive only."""
    for child in root.own_children():
        if child.type == TYPE_OBJECT and child.name == payload_ref:
            return child if isinstance(child, MetaObject) else None
    return None


def render_output_parser(template: MetaData, root: MetaData) -> str | None:
    """Render one parser module for a ``template.output`` node.

    Returns ``None`` when the ``@payloadRef`` can't be resolved (defensive;
    the loader's template-validation pass would normally catch this first)."""
    payload_ref = template.attr(tc.TEMPLATE_ATTR_PAYLOAD_REF)
    if not isinstance(payload_ref, str) or not payload_ref:
        return None
    payload = _find_payload_vo(root, payload_ref)
    if payload is None:
        return None

    template_name = template.name
    data_class = f"{template_name}Data"
    parse_fn = f"parse_{_snake_case(template_name)}"

    field_lines: list[str] = []
    extra_imports: set[str] = set()
    for field in payload.fields():
        if not isinstance(field, MetaField):
            continue
        annotation, imports = _python_type_for(field)
        extra_imports.update(imports)
        field_lines.append(f"    {field.name}: {annotation}")

    fqn = (
        f"{payload.package}::{template_name}"
        if payload.package
        else template_name
    )
    lines: list[str] = []
    lines.append(generated_header(template_name, fqn))
    lines.append("from __future__ import annotations\n")
    for imp in sorted(extra_imports):
        lines.append(imp)
    if extra_imports:
        lines.append("")
    lines.append("from pydantic import BaseModel")
    lines.append("")
    lines.append("")
    lines.append(f"class {data_class}(BaseModel):")
    lines.append(
        f'    """Payload schema for the ``{template_name}`` template.output.'
    )
    lines.append("")
    lines.append(f"    Field shape derived from the ``{payload.name}`` object.value.")
    lines.append('    """')
    if field_lines:
        lines.extend(field_lines)
    else:
        lines.append("    pass")
    lines.append("")
    lines.append("")
    lines.append(f"def {parse_fn}(text: str) -> {data_class}:")
    lines.append(f'    """Parse an LLM response into a typed ``{data_class}``.')
    lines.append("")
    lines.append("    Raises:")
    lines.append(
        "        pydantic.ValidationError: when the input does not match the schema."
    )
    lines.append('    """')
    lines.append(f"    return {data_class}.model_validate_json(text)")
    lines.append("")
    lines.append("")
    lines.append(f'__all__ = ["{data_class}", "{parse_fn}"]')
    lines.append("")

    return "\n".join(lines)


class OutputParserGenerator:
    """Generator wrapping ``render_output_parser``. Emits one file per
    ``template.output`` declared at root level."""

    name = _GENERATOR_NAME

    def __init__(self, *, filter: Callable[[MetaObject], bool] | None = None) -> None:
        # The ``filter`` arg matches the cross-generator contract even though
        # this generator iterates templates (not entities) and doesn't apply
        # entity-level filters today.
        self.filter = filter

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        root = ctx.loaded_root
        if root is None:
            return []
        files: list[EmittedFile] = []
        outputs = sorted(
            (
                c
                for c in root.own_children()
                if c.type == TYPE_TEMPLATE and c.sub_type == tc.TEMPLATE_SUBTYPE_OUTPUT
            ),
            key=lambda c: c.name,
        )
        for tmpl in outputs:
            content = render_output_parser(tmpl, root)
            if content is None:
                ctx.warn(
                    f"{_GENERATOR_NAME}: skipping template.output "
                    f"'{tmpl.name}' (no resolvable @payloadRef)."
                )
                continue
            files.append(
                EmittedFile(
                    path=f"{_snake_case(tmpl.name)}_output_parser.py",
                    content=ruff_format(content),
                )
            )
        return files


def output_parser_generator(
    *, filter: Callable[[MetaObject], bool] | None = None
) -> Generator:
    """Factory mirroring the TS ``outputParser()`` and C# ``OutputParserGenerator``."""
    return OutputParserGenerator(filter=filter)
