"""Response parser codegen — one ``<template_name>_response_parser.py`` per
responding ``template.prompt`` (one declaring ``@responseRef``).

FR-006 (Python) per ADR-0010 and ``docs/superpowers/specs/2026-05-25-fr6-python-template-output-parser.md``.

ADR-0052 — a template subtype's axis is DIRECTION. ``template.output`` renders
OUTBOUND (a document, an email) and gets no parser at all; the shape a reply is
parsed INTO is ``@responseRef`` on a ``template.prompt``, never ``@payloadRef``,
which types the request the prompt renders outbound. The direction rule itself
lives in :mod:`~metaobjects.codegen.generators.find_inbound` and is never
re-derived here.

Single-API throw-only convention matches the Python ecosystem norm: Pydantic
raises ``pydantic.ValidationError`` on bad input; callers wrap in ``try/except``
as needed. No dual API — TS uses ``parseX``/``safeParseX`` because Zod's
``safeParse`` is idiomatic; C# uses ``Parse``/``TryParse`` per BCL convention;
Python's ecosystem (Pydantic, Instructor, FastAPI, LangChain structured-output)
is throw-only and a dual surface would feel un-Pythonic.

Import-style emit: the parser module is a thin ``parse_<name>(text) -> Response``
wrapper that imports the Pydantic ``<TemplateName>Response`` model from the
sibling ``<template_name_snake>_response.py`` (emitted by
``payload_vo_generator``). This matches the cross-port story where one generated
record is shared by the parser and the extract tier — TS / C# / Java / Kotlin all
do the same.

The strict ``parse_*`` tier is JSON-ONLY, per ADR-0053: an XML reply gets the
tolerant extract and nothing strict (see
:func:`~metaobjects.codegen.generators.find_inbound.is_xml`)."""
from __future__ import annotations

from collections.abc import Callable

from metaobjects.apidocs.naming import snake_case as _snake_case
from metaobjects.codegen import extract_delegate_emitter as rde
from metaobjects.codegen.constants import generated_header
from metaobjects.codegen.format import ruff_format
from metaobjects.codegen.generator import EmittedFile, GenContext, Generator
from metaobjects.codegen.generators.find_inbound import (
    inbound_templates,
    is_xml,
    response_shape,
)
from metaobjects.codegen.generators.payload_vo_generator import (
    response_class_name,
    response_module_name,
)
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.meta_data import MetaData
from metaobjects.shared.separators import PACKAGE_SEP

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
    lookup, not a build-time codegen resolution). When two responding
    ``template.prompt``s in different packages declare an own ``@responseRef``
    shape that shares a bare name, that scan could silently bind whichever object
    the loader happened to iterate first.

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
    """Render one parser module for a responding ``template.prompt`` node.

    The emitted module imports ``<TemplateName>Response`` from the sibling
    response module (emitted by ``payload_vo_generator``) and exposes a
    throw-only ``parse_<name>(text)`` entry point.

    Returns ``None`` when the template declares no ``@responseRef`` or the ref
    does not resolve (defensive; the loader's template-validation pass would
    normally catch an unresolvable ref first)."""
    # ADR-0052: the shape parsed INTO is @responseRef — the reply. `response_shape`
    # resolves it through the SAME value-object target rule @payloadRef obeys, so a
    # parser can never bind a record the payload tier refused to emit.
    shape = response_shape(root, template, _pkg_of(template))
    if shape is None:
        return None
    payload = shape.vo

    # ADR-0044 (#228) — computed once, up front: does more than one root-level
    # object share this response VO's bare name? Drives BOTH the conditional
    # `resolve_object_ref` import below and the PAYLOAD_NAME/lookup emission
    # further down.
    payload_name_collides = _payload_name_collides(root, payload)

    template_name = template.name
    snake = _snake_case(template_name)
    payload_class = response_class_name(template_name)  # <Name>Response
    payload_module = response_module_name(template_name)  # <name>_response
    parse_fn = f"parse_{snake}"

    fqn = (
        f"{payload.package}::{template_name}"
        if payload.package
        else template_name
    )

    # ADR-0052/0053: the tolerant extract is now UNCONDITIONAL — declaring a response
    # shape IS the request for one, and @responseFormat is a closed json|xml set, so
    # there is no third case left to gate on. The reply's syntax comes from
    # @responseFormat, never @format (the syntax of the rendered prompt BODY); the old
    # @format gate is what let a text-bodied prompt asking for a JSON answer get a
    # strict parser and no extract at all.
    #
    # The strict Pydantic tier is JSON-ONLY: `model_validate_json` is an exact parser,
    # which is what makes strict all-or-nothing meaningful. Layering it over the
    # REPAIRING XML reader would raise or accept based on how much repair happened —
    # not a contract anyone can reason about. So an XML reply gets the tolerant
    # extract and nothing strict.
    emit_strict = not is_xml(shape.format)
    extracted_class = f"{payload_class}Extracted"
    extract_lenient_fn = f"extract_lenient_{snake}"

    lines: list[str] = [
        generated_header(template_name, fqn),
        "from __future__ import annotations\n",
    ]

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

    # The strict record is imported ONLY by the strict tier — an XML reply's module
    # would otherwise carry an unused import (the tolerant tier's return type is the
    # all-nullable ``…Extracted`` mirror declared right here). The record itself is
    # still emitted: the extract tier maps that mirror onto it.
    if emit_strict:
        lines.append(f"from .{payload_module} import {payload_class}")
    lines.append("")
    lines.append("")
    if emit_strict:
        lines.extend(
            [
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
    format_enum = "Format.XML" if is_xml(shape.format) else "Format.JSON"
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
    exported = [extract_lenient_with_fn, extracted_class, "PAYLOAD_NAME"]
    if emit_strict:
        exported.insert(0, parse_fn)
    joined = ", ".join(f'"{n}"' for n in exported)
    lines.append(f"__all__ = [{joined}]")

    lines.append("")
    return "\n".join(lines)


class OutputParserGenerator:
    """Generator wrapping ``render_output_parser``. Emits one file per responding
    ``template.prompt`` declared at root level (ADR-0052)."""

    name = _GENERATOR_NAME

    def __init__(self, *, filter: Callable[[MetaObject], bool] | None = None) -> None:
        # The ``filter`` arg matches the cross-generator contract even though
        # this generator iterates templates (not entities) and doesn't apply
        # entity-level filters today.
        self.filter = filter

    def _render_module(self, template: MetaData, root: MetaData) -> str | None:
        """EXTENSION SEAM — render the whole parser module for one responding
        ``template.prompt``. Defaults to :func:`render_output_parser` (the strict
        ``parse_*`` + the FR-010 tolerant ``extract_lenient_*`` twins). Override to
        pre/post-process the emitted source, or to replace the strict-parser /
        lenient-extractor emission entirely. Output is byte-identical to the default
        when not overridden."""
        return render_output_parser(template, root)

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        root = ctx.loaded_root
        if root is None:
            return []
        files: list[EmittedFile] = []
        # ADR-0052: the direction rule lives in FindInbound, never re-derived here.
        # Only a RESPONDING template.prompt gets a parser file; template.output
        # renders outbound and parses nothing.
        for tmpl in inbound_templates(root):
            content = self._render_module(tmpl, root)
            if content is None:
                ctx.warn(
                    f"{_GENERATOR_NAME}: skipping template.prompt "
                    f"'{tmpl.name}' (@responseRef does not resolve to a payload target)."
                )
                continue
            files.append(
                EmittedFile(
                    path=f"{_snake_case(tmpl.name)}_response_parser.py",
                    content=ruff_format(content),
                )
            )
        return files


def output_parser_generator(
    *, filter: Callable[[MetaObject], bool] | None = None
) -> Generator:
    """Factory mirroring the TS ``outputParser()`` and C# ``OutputParserGenerator``."""
    return OutputParserGenerator(filter=filter)
