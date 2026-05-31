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

from metaobjects.codegen import recover_delegate_emitter as rde
from metaobjects.codegen import recover_schema_emitter as rse
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

# FR-010: only structured formats get a tolerant recover() alongside the strict parser.
_RECOVER_FORMATS = frozenset({tc.TEMPLATE_FORMAT_JSON, tc.TEMPLATE_FORMAT_XML})


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
    snake = _snake_case(template_name)
    payload_class = payload_class_name(template_name)  # <Name>Payload
    payload_module = payload_module_name(template_name)  # <name>_payload
    parse_fn = f"parse_{snake}"

    fqn = (
        f"{payload.package}::{template_name}"
        if payload.package
        else template_name
    )

    # FR-010: emit the tolerant recover() API alongside the strict parser when the
    # template targets json/xml. Otherwise only the FR-006 strict parser is emitted
    # (text-format outputs get no recover). The mirror is a nullable twin of the
    # payload, so the strict ``parse_*`` is left exactly as FR-006 shipped it.
    fmt = template.attr(tc.TEMPLATE_ATTR_FORMAT)
    fmt_str = fmt if isinstance(fmt, str) else tc.TEMPLATE_FORMAT_DEFAULT
    emit_recover = fmt_str.lower() in _RECOVER_FORMATS
    recovered_class = f"{payload_class}Recovered"
    recover_fn = f"recover_{snake}"

    lines: list[str] = [
        generated_header(template_name, fqn),
        "from __future__ import annotations\n",
    ]

    if emit_recover:
        helpers = rse.recover_map_imports(payload)
        lines.append("from dataclasses import dataclass")
        lines.append("")
        lines.append("from metaobjects.render import (")
        lines.append("    FieldKind,")
        lines.append("    FieldSpec,")
        lines.append("    Format,")
        lines.append("    RecoverOptions,")
        lines.append("    RecoverSchema,")
        lines.append("    RecoveryResult,")
        lines.append("    recover,")
        lines.append(")")
        if helpers:
            lines.append("from metaobjects.render.recover.recover_map import (")
            for h in helpers:
                lines.append(f"    {h},")
            lines.append(")")
        # FR-010 nested-gap: the runtime-delegating path resolves the payload
        # MetaObject from a loaded MetaRoot and delegates to the metadata-driven
        # runtime recover (which assembles the FULL nested object graph
        # reflection-free). Codegen-wrapping-runtime — mirrors the Java/Kotlin/TS
        # pilots.
        lines.append(
            "from metaobjects.meta.core.object.meta_object import MetaObject"
        )
        lines.append(
            "from metaobjects.meta.core.object.object_recover import recover_object"
        )
        lines.append("from metaobjects.meta.meta_root import MetaRoot")
        lines.append("")

    lines.extend(
        [
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
        ]
    )

    if emit_recover:
        schema_literal = rse.schema_literal(payload, fmt_str, payload_class)
        initializer = rse.mirror_initializer(payload, recovered_class)
        # FR-010 nested-gap: the recovered mirror is emitted nested-AWARE — the
        # payload mirror keeps the canonical ``<Name>PayloadRecovered`` name, and a
        # mirror dataclass is emitted for every reachable nested value-object. Both
        # the self-contained ``recover_<name>()`` initializer (scalars/enums only)
        # and the delegating path share the ONE payload mirror type.
        lines.extend(rde.nested_mirror_dataclasses(payload, root, recovered_class))
        lines.append("")
        lines.append("")
        lines.append("# FR-010 baked recover descriptor — the format/root/field shape")
        lines.append("# the tolerant parser repairs dirty LLM output against.")
        lines.append(f"_RECOVER_SCHEMA: RecoverSchema = {schema_literal}")
        lines.append("")
        lines.append("")
        lines.append(
            f"def {recover_fn}("
            "text: str, opts: RecoverOptions | None = None"
            f") -> RecoveryResult[{recovered_class}]:"
        )
        lines.append(
            '    """Self-contained tolerant best-effort recovery of a dirty LLM response'
        )
        lines.append(f"    into a ``{recovered_class}`` mirror; never raises.")
        lines.append("")
        lines.append(f"    Unlike the strict ``{parse_fn}`` (Pydantic, throw-only), this folds")
        lines.append("    fenced / preamble / prose-wrapped / truncated input and classifies")
        lines.append("    each field via the returned report. Components are ``None`` where the")
        lines.append("    value was lost or malformed. Does NOT populate nested-object /")
        lines.append("    array-of-object components (those stay ``None`` — the historical")
        lines.append(f"    FR-010 gap); use ``{recover_fn}_with_loader(root, text)`` for full")
        lines.append('    nested recovery, which delegates to the runtime recover."""')
        lines.append("    outcome = recover(text, _RECOVER_SCHEMA, opts)")
        lines.append("    d = outcome.data")
        lines.append(f"    data = {initializer}")
        lines.append("    return RecoveryResult(data=data, report=outcome.report)")
        lines.append("")
        lines.append("")

        # ---- Runtime-delegating recover (closes the nested gap) ----
        # The baked PAYLOAD_NAME is the resolved payload VO's SIMPLE name: the
        # delegating entry resolves the MetaObject from a loaded MetaRoot by it
        # (root child named ``payload.name``), then delegates to the runtime
        # ``recover_object`` (FULL nested graph, reflection-free) and maps the
        # assembled ValueObject graph into the typed nullable mirror graph.
        format_enum = "Format.XML" if fmt_str.lower() == "xml" else "Format.JSON"
        root_mapper = rde.root_mapper_name(template_name)
        recover_with_fn = f"{recover_fn}_with_loader"
        lines.append("#: Payload value-object name this parser recovers — resolved")
        lines.append("#: against a loaded MetaRoot at runtime.")
        lines.append(f'PAYLOAD_NAME = "{payload.name}"')
        lines.append("")
        lines.append("")
        lines.extend(rde.nested_mappers(payload, root, root_mapper, recovered_class))
        lines.append("")
        lines.append("")
        lines.extend(rde.delegate_helpers(rde.used_helpers(payload, root)))
        lines.append("")
        lines.append("")
        lines.append(
            f"def {recover_with_fn}("
            "root: MetaRoot, text: str, opts: RecoverOptions | None = None"
            f") -> RecoveryResult[{recovered_class}]:"
        )
        lines.append(
            '    """Runtime-delegating tolerant recovery; never raises. Unlike'
        )
        lines.append(f"    ``{recover_fn}(text)``, this FULLY populates nested-object and")
        lines.append("    array-of-object components by delegating to the metadata-driven")
        lines.append("    runtime ``recover_object`` (which assembles the whole graph")
        lines.append("    reflection-free via the Phase A object model), then maps the")
        lines.append(f"    assembled graph into the typed ``{recovered_class}`` mirror.")
        lines.append("")
        lines.append("    :param root: a loaded ``MetaRoot`` that declares the")
        lines.append(f'                 ``{payload.name}`` value-object."""')
        lines.append("    mo = None")
        lines.append("    for child in root.own_children():")
        lines.append("        if (")
        lines.append("            isinstance(child, MetaObject)")
        lines.append("            and child.name == PAYLOAD_NAME")
        lines.append("        ):")
        lines.append("            mo = child")
        lines.append("            break")
        lines.append("    if mo is None:")
        lines.append("        raise ValueError(")
        lines.append(
            f'            f"{recover_with_fn}: payload \'{{PAYLOAD_NAME}}\' not found "'
        )
        lines.append('            "in the supplied MetaRoot"')
        lines.append("        )")
        lines.append(
            f"    outcome = recover_object(mo, text, {format_enum}, opts)"
        )
        lines.append(f"    data = {root_mapper}(outcome.data)")
        lines.append("    return RecoveryResult(data=data, report=outcome.report)")
        lines.append("")
        lines.append("")
        lines.append(
            f'__all__ = ["{parse_fn}", "{recover_fn}", "{recover_with_fn}", '
            f'"{recovered_class}", "PAYLOAD_NAME"]'
        )
    else:
        lines.append(f'__all__ = ["{parse_fn}"]')

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
