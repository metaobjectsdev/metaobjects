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

from metaobjects.apidocs.naming import snake_case as _snake_case
from metaobjects.codegen import extract_delegate_emitter as rde
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

# FR-010: only structured formats get a tolerant extract() alongside the strict parser.
_EXTRACT_FORMATS = frozenset({tc.TEMPLATE_FORMAT_JSON, tc.TEMPLATE_FORMAT_XML})


_GENERATOR_NAME = "output-parser-generator"


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

    # FR-010: emit the tolerant extract() API alongside the strict parser when the
    # template targets json/xml. Otherwise only the FR-006 strict parser is emitted
    # (text-format outputs get no extract). The mirror is a nullable twin of the
    # payload, so the strict ``parse_*`` is left exactly as FR-006 shipped it.
    fmt = template.attr(tc.TEMPLATE_ATTR_FORMAT)
    fmt_str = fmt if isinstance(fmt, str) else tc.TEMPLATE_FORMAT_DEFAULT
    emit_extract_lenient = fmt_str.lower() in _EXTRACT_FORMATS
    extracted_class = f"{payload_class}Extracted"
    extract_lenient_fn = f"extract_lenient_{snake}"

    lines: list[str] = [
        generated_header(template_name, fqn),
        "from __future__ import annotations\n",
    ]

    if emit_extract_lenient:
        lines.append("from dataclasses import dataclass")
        lines.append("")
        lines.append("from metaobjects.render import (")
        lines.append("    Format,")
        lines.append("    ExtractOptions,")
        lines.append("    ExtractionResult,")
        lines.append(")")
        # FR-010: the single metadata-driven extract path resolves the payload
        # MetaObject from a loaded MetaRoot and delegates to the runtime extract
        # (which assembles the FULL nested object graph reflection-free by reading
        # the live metadata directly). Codegen-wrapping-runtime — mirrors the
        # Java/Kotlin/TS pilots.
        lines.append(
            "from metaobjects.meta.core.object.meta_object import MetaObject"
        )
        lines.append(
            "from metaobjects.meta.core.object.object_extract import extract_object"
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

    if emit_extract_lenient:
        # FR-010 nested-AWARE extracted mirror: the payload mirror keeps the canonical
        # ``<Name>PayloadExtracted`` name, and a mirror dataclass is emitted for every
        # reachable nested value-object. The single (delegating) extract path returns it.
        lines.extend(rde.nested_mirror_dataclasses(payload, root, extracted_class))
        lines.append("")
        lines.append("")

        # ---- Runtime-delegating extract (the single metadata-driven extract path) ----
        # The baked PAYLOAD_NAME is the resolved payload VO's SIMPLE name: the
        # delegating entry resolves the MetaObject from a loaded MetaRoot by it
        # (root child named ``payload.name``), then delegates to the runtime
        # ``extract_object`` (FULL nested graph, reflection-free) and maps the
        # assembled ValueObject graph into the typed nullable mirror graph.
        format_enum = "Format.XML" if fmt_str.lower() == "xml" else "Format.JSON"
        root_mapper = rde.root_mapper_name(template_name)
        extract_lenient_with_fn = f"{extract_lenient_fn}_with_loader"
        lines.append("#: Payload value-object name this parser extracts — resolved")
        lines.append("#: against a loaded MetaRoot at runtime.")
        lines.append(f'PAYLOAD_NAME = "{payload.name}"')
        lines.append("")
        lines.append("")
        lines.extend(rde.nested_mappers(payload, root, root_mapper, extracted_class))
        lines.append("")
        lines.append("")
        lines.extend(rde.delegate_helpers(rde.used_helpers(payload, root)))
        lines.append("")
        lines.append("")
        lines.append(
            f"def {extract_lenient_with_fn}("
            "root: MetaRoot, text: str, opts: ExtractOptions | None = None"
            f") -> ExtractionResult[{extracted_class}]:"
        )
        lines.append(
            '    """Runtime-delegating tolerant best-effort extraction; never raises.'
        )
        lines.append("    FULLY populates nested-object and array-of-object components by")
        lines.append("    delegating to the metadata-driven runtime ``extract_object`` (which")
        lines.append("    assembles the whole graph reflection-free via the Phase A object")
        lines.append("    model, reading the live metadata directly), then maps the assembled")
        lines.append(f"    graph into the typed ``{extracted_class}`` mirror.")
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
            f'            f"{extract_lenient_with_fn}: payload \'{{PAYLOAD_NAME}}\' not found "'
        )
        lines.append('            "in the supplied MetaRoot"')
        lines.append("        )")
        lines.append(
            f"    outcome = extract_object(mo, text, {format_enum}, opts)"
        )
        lines.append(f"    data = {root_mapper}(outcome.data)")
        lines.append("    return ExtractionResult(data=data, report=outcome.report)")
        lines.append("")
        lines.append("")
        lines.append(
            f'__all__ = ["{parse_fn}", "{extract_lenient_with_fn}", '
            f'"{extracted_class}", "PAYLOAD_NAME"]'
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

    def _render_module(self, template: MetaData, root: MetaData) -> str | None:
        """EXTENSION SEAM — render the whole parser module for one ``template.output``.
        Defaults to :func:`render_output_parser` (the strict ``parse_*`` + the FR-010
        tolerant ``extract_lenient_*`` twins). Override to pre/post-process the
        emitted source, or to replace the strict-parser / lenient-extractor emission
        entirely. Output is byte-identical to the default when not overridden."""
        return render_output_parser(template, root)

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
            content = self._render_module(tmpl, root)
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
