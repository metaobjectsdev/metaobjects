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
from metaobjects.shared.separators import PACKAGE_SEP

# FR-010: only structured formats get a tolerant extract() alongside the strict parser.
_EXTRACT_FORMATS = frozenset({tc.TEMPLATE_FORMAT_JSON, tc.TEMPLATE_FORMAT_XML})


_GENERATOR_NAME = "output-parser-generator"


def _pkg_of(node: MetaData) -> str:
    """The effective package of a node — its ``resolution_key()`` minus the
    trailing ``::<name>`` ("" for a root-level node). Duplicated (not imported) to
    match the existing per-generator convention (``payload_vo_generator.py`` /
    ``render_helper_generator.py`` / ``extract_delegate_emitter.py`` each carry
    their own identical copy). Used to derive a template's referrer package for
    ``resolve_payload_vo`` — see that function's docstring for why this
    ancestor-walk-aware form is used instead of the loader's bare
    ``tpl.package or tpl.file_default_package or ""`` (equivalent for any
    loader-parsed tree; ALSO correct for this generator's hand-built test trees)."""
    key = node.resolution_key()
    i = key.rfind(PACKAGE_SEP)
    return "" if i == -1 else key[:i]


def _payload_name_collides(root: MetaData, payload: MetaObject) -> bool:
    """ADR-0044 (#228) — True iff more than one root-level ``MetaObject`` (ANY
    subtype — matching the exact domain the GENERATED runtime lookup itself
    scans: ``isinstance(child, MetaObject)``, no subtype filter) shares
    *payload*'s bare ``name``.

    The emitted ``extract_lenient_*_with_loader`` resolves its payload at
    RUNTIME via a bare-name-only, load-order-dependent first-match scan over
    ``root.own_children()`` — the same ADR-0042 "wrong node" hazard class
    ``ref_vo`` had before #228, just one layer up (a generated-code runtime
    lookup, not a build-time codegen resolution). When two ``template.output``s
    in different packages declare an own ``@payloadRef`` payload that shares a
    bare name, that scan could silently bind whichever object the loader
    happened to iterate first.

    Mirrors the TS reference (``output-parser.ts``'s ``payloadNameCollides``,
    driven there by the entity-domain name map Task 3 built for the whole
    run). Python's payload-record tier has no equivalent whole-run name map to
    reuse for this signal (its ADR-0044 closure is scoped per-payload, not
    global) — so this computes the identical collision FACT directly against
    ``root.own_children()``, the actual domain the generated scan searches."""
    return (
        sum(
            1
            for c in root.own_children()
            if isinstance(c, MetaObject) and c.name == payload.name
        )
        > 1
    )


def render_output_parser(template: MetaData, root: MetaData) -> str | None:
    """Render one parser module for a ``template.output`` node.

    The emitted module imports ``<TemplateName>Payload`` from the sibling
    payload module (emitted by ``payload_vo_generator``) and exposes a
    throw-only ``parse_<name>(text)`` entry point.

    Returns ``None`` when the ``@payloadRef`` can't be resolved (defensive;
    the loader's template-validation pass would normally catch this first)."""
    payload_ref = template.get_meta_attr(tc.TEMPLATE_ATTR_PAYLOAD_REF)  # ADR-0039: template attr resolves via extends (not origin; templates CAN extend)
    if not isinstance(payload_ref, str) or not payload_ref:
        return None
    # ADR-0042 (#228): the referrer is THIS template — a bare @payloadRef resolves
    # in ITS OWN package first.
    payload = resolve_payload_vo(root, payload_ref, _pkg_of(template))
    if payload is None:
        return None

    # ADR-0044 (#228) — computed once, up front: does more than one root-level
    # object share this payload's bare name? Drives BOTH the conditional
    # `resolve_object_ref` import below and the PAYLOAD_NAME/lookup emission
    # further down. Only relevant when the extract-lenient block is emitted
    # (text-format outputs never bake a runtime payload lookup at all).
    payload_name_collides = _payload_name_collides(root, payload)

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
    fmt = template.get_meta_attr(tc.TEMPLATE_ATTR_FORMAT)  # ADR-0039: template attr resolves via extends (not origin; templates CAN extend)
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
        #
        # ADR-0044 (#228) — the payload lookup below is EITHER a bare
        # `root.own_children()` scan (needs the `MetaObject` isinstance check) OR,
        # on a bare-name collision, a canonical FQN-exact `resolve_object_ref` (needs
        # no `MetaObject` import) — so exactly ONE of these two imports is emitted,
        # never both, keeping the generated module import-clean either way.
        if payload_name_collides:
            lines.append("from metaobjects.naming_refs import resolve_object_ref")
        else:
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
        # ADR-0044 (#228) — the collision-scoped BASE name map for the payload's
        # reachable nested-VO closure (bare unless a cross-package bare-name
        # collision requires package-qualification). Computed ONCE and threaded
        # through both the mirror dataclasses and the mappers below so a nested
        # VO's ``<Base>Extracted`` name and its `_from_<base>_extracted` mapper
        # agree — and so the STRICT payload class the extractor tier imports for
        # the SAME base (see extractor_generator.py) can never diverge.
        name_map = rde.build_name_map(payload, root)

        # FR-010 nested-AWARE extracted mirror: the payload mirror keeps the canonical
        # ``<Name>PayloadExtracted`` name, and a mirror dataclass is emitted for every
        # reachable nested value-object. The single (delegating) extract path returns it.
        lines.extend(rde.nested_mirror_dataclasses(payload, root, extracted_class, name_map))
        lines.append("")
        lines.append("")

        # ---- Runtime-delegating extract (the single metadata-driven extract path) ----
        # The baked PAYLOAD_NAME is normally the resolved payload VO's SIMPLE name: the
        # delegating entry resolves the MetaObject from a loaded MetaRoot by it
        # (root child named ``payload.name``), then delegates to the runtime
        # ``extract_object`` (FULL nested graph, reflection-free) and maps the
        # assembled ValueObject graph into the typed nullable mirror graph.
        #
        # ADR-0044 (#228) — a bare ``root.own_children()`` first-match scan (below) is a
        # load-order-dependent "wrong node" hazard when this payload's OWN bare name
        # collides with another root-level object elsewhere in the run (see
        # ``_payload_name_collides``). When it does, PAYLOAD_NAME bakes the FQN
        # (``resolution_key()``) and the lookup resolves via the canonical ADR-0042
        # ``resolve_object_ref`` (FQN-exact, load-order-independent) instead of the
        # scan. A non-colliding payload keeps the bare name + the scan — byte-identical
        # to pre-#228 output.
        format_enum = "Format.XML" if fmt_str.lower() == "xml" else "Format.JSON"
        root_mapper = rde.root_mapper_name(template_name)
        extract_lenient_with_fn = f"{extract_lenient_fn}_with_loader"
        baked_payload_name = (
            payload.resolution_key() if payload_name_collides else payload.name
        )
        lines.append("#: Payload value-object name this parser extracts — resolved")
        if payload_name_collides:
            lines.append("#: against a loaded MetaRoot at runtime. ADR-0042 FQN (this")
            lines.append("#: payload's bare name collides with a same-short-name")
            lines.append("#: object elsewhere in the run).")
        else:
            lines.append("#: against a loaded MetaRoot at runtime.")
        lines.append(f'PAYLOAD_NAME = "{baked_payload_name}"')
        lines.append("")
        lines.append("")
        lines.extend(
            rde.nested_mappers(payload, root, root_mapper, extracted_class, name_map)
        )
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
        if payload_name_collides:
            # ADR-0044 (#228) — PAYLOAD_NAME is a baked FQN; resolve it via the
            # canonical ADR-0042 package-local contract (FQN-exact here, so the
            # "" referrer package is inert) rather than a bare load-order-dependent
            # scan.
            lines.append('    mo = resolve_object_ref(root, PAYLOAD_NAME, "")')
        else:
            lines.append("    mo = None")
            # Emits a root-scan into generated code: root is the loader ROOT (never
            # extended, so own == effective) — ADR-0039 sanctioned own in emitted code.
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
                # ADR-0039 sanctioned own: top-level scan on the loader ROOT (never extended, own == effective)
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
