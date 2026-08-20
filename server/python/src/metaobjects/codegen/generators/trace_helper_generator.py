"""Trace-helper codegen — one ``record_<entity>.py`` per concrete ``object.entity``
that (a) transitively ``extends`` ``metaobjects::ai::LlmCallBase`` AND (b) nests a
``template.prompt`` carrying ``@responseRef`` and/or ``@payloadRef``.

AI LLM-call trace persistence — Unit 2 Slice 2 (Python port). Cross-port parity
with the TypeScript ``trace-helper-file.ts`` (``record<Entity>`` + ``call<Entity>``)
and the Java ``LlmTraceHelperGenerator`` (``record<Entity>`` only). This Python
port emits the ``record_<entity>`` half ONLY — the render→call→record loop needs an
``LlmClient`` seam that is BYO / vendor-neutral (ADR-0024), so ``call<Entity>`` is
intentionally NOT emitted (matching Java).

The emitted helper exposes a single ``record_<snake>(recorder, input, redact=None)``
that:

1. runs the tolerant extract (``extract`` from ``metaobjects.render.extract``,
   which NEVER raises) of ``input.llm_response_text`` against a baked
   ``_RESPONSE_SCHEMA`` (the response VO's field shape — emitted via the SAME
   ``extract_schema_emitter`` path the output-parser generator uses for its
   tolerant ``extract_lenient_*`` twin);
2. derives ``status``/``error_detail`` from the extract report's lost-required gate
   (a lost ``@required`` field → ``status="error"`` + a ``"lost required: …"`` detail);
3. builds the base trace row via the Slice-1 ``build_llm_call_row`` (the 18
   ``LlmCallBase`` base fields + raw ``llmRequest``/``llmResponse``), folding in the
   derived status/error_detail by replacing the input;
4. sets the typed ``voRequest`` (``input.llm_request``) and ``voResponse``
   (``outcome.data`` — the extracted mirror dict) columns on the row → native jsonb;
5. persists the row ONCE via the supplied recorder (the never-throwing Slice-1
   ``persist_llm_call_row``, which redacts then records);
6. returns a typed ``<Entity>TraceResult`` (``status``, ``error_detail``,
   ``vo_response``).

Skips (no helper emitted) when the entity is abstract, does not derive from
``LlmCallBase``, has no nested ``template.prompt``, or that prompt carries NEITHER
``@responseRef`` NOR ``@payloadRef`` (both gate the helper — matching the TS
reference). The response VO is resolved via ``resolve_payload_vo`` (short-name OR
FQN); a non-``object.value`` target is a hard generator error (matching Java).

STI/TPH discriminator handling is DEFERRED (matching the Java port's Slice 2 — a
plain trace entity is the target).
"""
from __future__ import annotations

from collections.abc import Callable

from metaobjects.codegen import extract_schema_emitter as rse
from metaobjects.codegen.constants import generated_header
from metaobjects.codegen.format import ruff_format
from metaobjects.codegen.generator import EmittedFile, GenContext, Generator
from metaobjects.codegen.generators.find_inbound import response_format_of
from metaobjects.codegen.generators.payload_vo_generator import resolve_payload_vo
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.object.object_constants import OBJECT_SUBTYPE_ENTITY
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.template import template_constants as tc
from metaobjects.meta.template.meta_template import MetaTemplate
from metaobjects.shared.base_types import TYPE_TEMPLATE
from metaobjects.shared.separators import PACKAGE_SEP

_GENERATOR_NAME = "trace-helper"

#: The abstract base entity a trace entity must (transitively) ``extends``.
#: Cross-port constant — mirrors TS ``LLM_CALL_BASE`` / Java ``LLM_CALL_BASE``.
LLM_CALL_BASE = "LlmCallBase"


def _pkg_of(node: MetaData) -> str:
    """The effective package of a node — its ``resolution_key()`` minus the
    trailing ``::<name>`` ("" for a root-level node). Duplicated (not imported) to
    match the existing per-generator convention. Used to derive the referring
    ``template.prompt``'s package for ``resolve_payload_vo`` (#228) — see that
    function's docstring for why this ancestor-walk-aware form is used instead of
    the loader's bare ``tpl.package or tpl.file_default_package or ""``."""
    key = node.resolution_key()
    i = key.rfind(PACKAGE_SEP)
    return "" if i == -1 else key[:i]


def _snake_case(name: str) -> str:
    """``GreetingCall`` → ``greeting_call``. PascalCase → snake_case with no
    acronym handling — matches the convention used by sibling generators
    (``output_parser_generator._snake_case`` etc.)."""
    out: list[str] = []
    for i, ch in enumerate(name):
        if ch.isupper() and i > 0:
            out.append("_")
        out.append(ch.lower())
    return "".join(out)


def _extends_base(entity: MetaObject) -> bool:
    """Walk the resolved super chain looking for a node SHORT-named
    :data:`LLM_CALL_BASE`. ``MetaData.name`` holds the short name only (the package
    lives on ``MetaData.package``), so a plain ``name`` compare is the short-name
    test — mirrors the Java ``getShortName()`` walk and the TS ``superResolved``
    walk."""
    cur = entity.super_data
    visited: set[int] = set()
    while cur is not None and id(cur) not in visited:
        if cur.name == LLM_CALL_BASE:
            return True
        visited.add(id(cur))
        cur = cur.super_data
    return False


def _first_prompt(entity: MetaObject) -> MetaTemplate | None:
    """First OWN ``template.prompt`` child of *entity*, or ``None``. Own-only —
    the trace prompt is declared inline on the concrete trace entity (Slice 1/3
    derive the typed columns from it).

    ADR-0039 sanctioned own: byte-for-byte parity with the TS trace-helper
    (``entity.ownChildren().find(... template.prompt ...)``); the trace prompt is a
    per-entity inline declaration, not an inherited member."""
    for child in entity.own_children():
        if (
            isinstance(child, MetaTemplate)
            and child.type == TYPE_TEMPLATE
            and child.sub_type == tc.TEMPLATE_SUBTYPE_PROMPT
        ):
            return child
    return None


def render_trace_helper(entity: MetaObject, root: MetaData) -> str | None:
    """Render one ``record_<entity>.py`` for a concrete trace ``object.entity``.

    Returns ``None`` when the entity is not a trace-helper target (abstract, not
    ``LlmCallBase``-derived, no nested ``template.prompt``, or that prompt carries
    neither ``@responseRef`` nor ``@payloadRef``).

    Raises ``ValueError`` when the prompt's ``@responseRef`` does not resolve to an
    ``object.value`` or sourceless ``object.projection`` (#210; matching the Java
    port's hard ``GeneratorException``)."""
    if entity.is_abstract:
        return None
    if not _extends_base(entity):
        return None

    prompt = _first_prompt(entity)
    if prompt is None:
        return None

    response_ref = prompt.response_ref()
    payload_ref = prompt.payload_ref()
    # Both gate the helper — at least one of @responseRef / @payloadRef must be
    # present (matches the TS reference, which needs @responseRef to type the result
    # and @payloadRef to type the request).
    if response_ref is None and payload_ref is None:
        return None

    # The response VO drives the baked extract schema + the typed voResponse. When
    # only @payloadRef is set we still emit a helper (the request is typed); the
    # extract schema falls back to an empty descriptor (no response VO to shape it).
    # ADR-0042 (#228): the referrer is the PROMPT (a bare @responseRef resolves in
    # its own package first — the prompt is nested inside `entity` but carries its
    # OWN effective package via resolution_key()'s ancestor walk).
    response_vo = (
        resolve_payload_vo(root, response_ref, _pkg_of(prompt)) if response_ref else None
    )
    if response_ref is not None and response_vo is None:
        raise ValueError(
            f"{_GENERATOR_NAME}: entity {entity.name!r} prompt @responseRef "
            f"{response_ref!r} does not resolve to an object.value or sourceless "
            f"object.projection"
        )

    entity_name = entity.name
    snake = _snake_case(entity_name)
    record_fn = f"record_{snake}"
    result_class = f"{entity_name}TraceResult"

    # ADR-0053: the REPLY's syntax is @responseFormat, not @format.
    #
    # This site used to read @format — the syntax of the rendered prompt BODY — to
    # decide how to parse the model's ANSWER. They are two different FACTS: a
    # plain-text prompt can elicit an XML reply, and the shipped docs-site fixture is
    # exactly that shape. The SAME rule the output-parser / extractor /
    # response-format-fragment generators use — all four go through `response_format_of`.
    reply_fmt = response_format_of(prompt)

    fqn = entity.fqn()

    # Baked response-extract schema. REUSE the extract_schema_emitter exactly as the
    # output-parser generator does for its tolerant ``extract_lenient_*`` twin:
    # ``schema_literal(vo, fmt, root_name)`` emits an
    # ``ExtractSchema(Format.X, "<root>", [FieldSpec(...), …])`` literal, and
    # ``extract_map_imports(vo)`` returns the sorted/deduped ``extract_map`` accessor
    # names the literal's FieldSpec helpers reference. ``root_name`` is the response
    # VO's short name (the JSON/XML root the tolerant reader locates). When there is
    # no response VO (only @payloadRef set) the schema is an empty descriptor whose
    # extract yields ``{}``.
    if response_vo is not None:
        schema_literal = rse.schema_literal(response_vo, reply_fmt, response_vo.name)
        helpers = rse.extract_map_imports(response_vo)
    else:
        schema_literal = f'ExtractSchema({_format_enum(reply_fmt)}, "response", [])'
        helpers = []

    request_doc = payload_ref if payload_ref else "the structured request object"

    lines: list[str] = [
        generated_header(entity_name, fqn),
        "from __future__ import annotations",
        "",
        "import dataclasses",
        "from dataclasses import dataclass",
        "",
        "from metaobjects.render.extract import (",
        "    ExtractSchema,",
        "    FieldKind,",
        "    FieldSpec,",
        "    Format,",
        "    extract,",
        ")",
    ]
    if helpers:
        lines.append("from metaobjects.render.extract.extract_map import (")
        for h in helpers:
            lines.append(f"    {h},")
        lines.append(")")
    lines.extend(
        [
            "from metaobjects.runtime import (",
            "    LlmCallInput,",
            "    LlmCallRecorder,",
            "    LlmCallRow,",
            "    STATUS_ERROR,",
            "    STATUS_OK,",
            "    build_llm_call_row,",
            "    persist_llm_call_row,",
            ")",
            "",
            "from collections.abc import Callable",
            "",
            "",
            "# AI-trace baked response-extract descriptor — the format/root/field shape",
            "# the tolerant parser repairs the model's raw response text against.",
            f"_RESPONSE_SCHEMA: ExtractSchema = {schema_literal}",
            "",
            "",
            "@dataclass(frozen=True, slots=True)",
            f"class {result_class}:",
            f'    """Typed result of ``{record_fn}``: the derived call outcome plus the',
            "    best-effort extracted response VO.",
            "",
            "    * ``status`` — ``STATUS_OK`` | ``STATUS_ERROR`` (a lost ``@required``",
            "      response field → ``STATUS_ERROR``).",
            "    * ``error_detail`` — a ``\"lost required: …\"`` summary when ``status`` is",
            "      ``STATUS_ERROR``, else ``None``.",
            "    * ``vo_response`` — the extracted response mirror dict (``None`` only when",
            '      extraction produced nothing)."""',
            "    status: str",
            "    error_detail: str | None",
            "    vo_response: dict | None",
            "",
            "",
            f"def {record_fn}(",
            "    recorder: LlmCallRecorder,",
            "    input: LlmCallInput,",
            "    redact: Callable[[LlmCallRow], LlmCallRow] | None = None,",
            f") -> {result_class}:",
            f'    """Record a single ``{entity_name}`` LLM call: extract the typed response',
            "    VO from ``input.llm_response_text`` and persist ONE trace row (the base",
            "    envelope + raw I/O + typed voRequest/voResponse) via ``recorder`` —",
            "    regardless of whether extraction succeeded.",
            "",
            "    The tolerant ``extract`` NEVER raises; a lost ``@required`` response field",
            "    drives ``status``/``error_detail`` (it does not abort the persist). The",
            f"    request payload (``input.llm_request``, typed as ``{request_doc}`` at the",
            "    call site) is threaded through as the typed ``voRequest`` column.",
            "",
            "    :param recorder: the never-throwing write-side seam (Slice-1 recorder).",
            "    :param input:    the LLM call fields (envelope + raw request/response text).",
            "    :param redact:   optional row redaction applied before the single record.",
            '    """',
            "    outcome = extract(input.llm_response_text, _RESPONSE_SCHEMA)",
            "    failed = outcome.report.has_lost_required()",
            "    status = STATUS_ERROR if failed else STATUS_OK",
            "    error_detail = (",
            '        "lost required: " + ", ".join(outcome.report.lost_required())',
            "        if failed",
            "        else None",
            "    )",
            "    # Extraction owns the derived status/error_detail — fold them into the input",
            "    # before building the base row (dataclasses.replace, leaving the original",
            "    # input untouched).",
            "    effective = dataclasses.replace(",
            "        input, status=status, error_detail=error_detail",
            "    )",
            "    row = build_llm_call_row(effective)",
            "    # Typed columns → native jsonb (pg8000 binds dict/list straight to jsonb).",
            "    row[\"voResponse\"] = outcome.data",
            "    row[\"voRequest\"] = input.llm_request",
            "    # Persist ONCE (redact-then-record; the recorder never raises).",
            "    persist_llm_call_row(recorder, row, redact)",
            f"    return {result_class}(status, error_detail, outcome.data)",
            "",
            "",
            f'__all__ = ["{record_fn}", "{result_class}"]',
            "",
        ]
    )
    return "\n".join(lines)


def _format_enum(fmt: str) -> str:
    """``"xml"`` → ``Format.XML``; anything else → ``Format.JSON``. Matches the
    extract_schema_emitter's private ``_format_enum`` (kept local to avoid reaching
    into a private helper)."""
    return "Format.XML" if fmt.lower() == tc.TEMPLATE_FORMAT_XML else "Format.JSON"


class TraceHelperGenerator:
    """Generator wrapping :func:`render_trace_helper`. Emits one
    ``record_<entity>.py`` per concrete ``object.entity`` that derives from
    ``LlmCallBase`` and nests a ``template.prompt`` with ``@responseRef`` /
    ``@payloadRef`` (skips everything else)."""

    name = _GENERATOR_NAME

    def __init__(self, *, filter: Callable[[MetaObject], bool] | None = None) -> None:
        # The ``filter`` arg matches the cross-generator contract.
        self.filter = filter

    def _render_module(self, entity: MetaObject, root: MetaData) -> str | None:
        """EXTENSION SEAM — render the whole ``record_<entity>`` module for one trace
        entity. Defaults to :func:`render_trace_helper`. Override to pre/post-process
        the emitted source or replace the render path entirely."""
        return render_trace_helper(entity, root)

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        root = ctx.loaded_root
        if root is None:
            return []
        files: list[EmittedFile] = []
        # Stable name order — deterministic emission (matches the other generators).
        # ADR-0039 sanctioned own: top-level entity scan on the loader ROOT
        # (metadata.root is never extended, so own == effective).
        entities = sorted(
            (
                c
                for c in root.own_children()
                if isinstance(c, MetaObject) and c.sub_type == OBJECT_SUBTYPE_ENTITY
            ),
            key=lambda c: c.name,
        )
        for entity in entities:
            if self.filter is not None and not self.filter(entity):
                continue
            content = self._render_module(entity, root)
            if content is None:
                continue
            files.append(
                EmittedFile(
                    path=f"record_{_snake_case(entity.name)}.py",
                    content=ruff_format(content),
                )
            )
        return files


def trace_helper_generator(
    *, filter: Callable[[MetaObject], bool] | None = None
) -> Generator:
    """Factory mirroring the TS ``traceHelperFile()`` and the Java
    ``LlmTraceHelperGenerator``. Stable cross-port name ``trace-helper``."""
    return TraceHelperGenerator(filter=filter)
