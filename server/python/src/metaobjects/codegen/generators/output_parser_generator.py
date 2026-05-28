"""Output parser codegen — one ``<template_name>_output_parser.py`` per
``template.output`` declaration.

FR-006 (Python) per ADR-0010 and ``docs/superpowers/specs/2026-05-25-fr6-python-template-output-parser.md``.

Single-API throw-only convention matches the Python ecosystem norm: Pydantic
raises ``pydantic.ValidationError`` on bad input; callers wrap in ``try/except``
as needed. No dual API — TS uses ``parseX``/``safeParseX`` because Zod's
``safeParse`` is idiomatic; C# uses ``Parse``/``TryParse`` per BCL convention;
Python's ecosystem (Pydantic, Instructor, FastAPI, LangChain structured-output)
is throw-only and a dual surface would feel un-Pythonic.

Import-style emit: the parser module is a thin ``parse_<name>(text) -> Payload``
wrapper that imports the Pydantic ``<TemplateName>Payload`` model from the
sibling ``<template_name_snake>_payload.py`` (emitted by ``payload_vo_generator``).
This matches the cross-port story where a single payload-VO class is reused by
both prompt rendering and output parsing — TS / C# / Kotlin all do the same.

The generator emits an empty file list when ``payload_vo_generator`` would have
emitted nothing for the same template (defensive parity with the loader's
``@payloadRef`` validation pass)."""
from __future__ import annotations

from collections.abc import Callable

from metaobjects.codegen.constants import generated_header
from metaobjects.codegen.format import ruff_format
from metaobjects.codegen.generator import EmittedFile, GenContext, Generator
from metaobjects.codegen.generators.payload_vo_generator import (
    payload_class_name,
    payload_module_name,
    resolve_payload_vo,
)
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.template import template_constants as tc
from metaobjects.shared.base_types import TYPE_TEMPLATE


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


def render_output_parser(template: MetaData, root: MetaData) -> str | None:
    """Render one parser module for a ``template.output`` node.

    The emitted module imports ``<TemplateName>Payload`` from the sibling
    payload module (emitted by ``payload_vo_generator``) and exposes a
    throw-only ``parse_<name>(text)`` entry point.

    Returns ``None`` when the ``@payloadRef`` can't be resolved (defensive;
    the loader's template-validation pass would normally catch this first)."""
    payload_ref = template.attr(tc.TEMPLATE_ATTR_PAYLOAD_REF)
    if not isinstance(payload_ref, str) or not payload_ref:
        return None
    payload = resolve_payload_vo(root, payload_ref)
    if payload is None:
        return None

    template_name = template.name
    payload_class = payload_class_name(template_name)  # <Name>Payload
    payload_module = payload_module_name(template_name)  # <name>_payload
    parse_fn = f"parse_{_snake_case(template_name)}"

    fqn = (
        f"{payload.package}::{template_name}"
        if payload.package
        else template_name
    )

    lines: list[str] = [
        generated_header(template_name, fqn),
        "from __future__ import annotations\n",
        f"from .{payload_module} import {payload_class}",
        "",
        "",
        f"def {parse_fn}(text: str) -> {payload_class}:",
        f'    """Parse an LLM response into a typed ``{payload_class}``.',
        "",
        "    Raises:",
        "        pydantic.ValidationError: when the input does not match the schema.",
        '    """',
        f"    return {payload_class}.model_validate_json(text)",
        "",
        "",
        f'__all__ = ["{parse_fn}"]',
        "",
    ]

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
