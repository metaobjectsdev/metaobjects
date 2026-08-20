"""Payload-VO codegen — one ``<template_name_snake>_payload.py`` per declared
``template.*`` (prompt / output / toolcall).

FR-006 (Python) — cross-port parity with the Kotlin ``KotlinPayloadGenerator``
(server/java/codegen-kotlin), C# ``MetaObjects.Codegen.PayloadVoGenerator``, and
TS payload-VO emit. The Python output-parser generator (FR-006) was originally
self-contained — it embedded its Pydantic model inline pending a payload-VO
generator. With this module shipping, the parser generator switches to an
import-style emit so a single payload class is reused by both prompt rendering
and output parsing (matches the Java payload-VO ↔ Java output-parser handoff).

Each generated file declares a Pydantic v2 ``BaseModel`` per template. Field
typing is DECLARED-TYPE-AUTHORITATIVE (#270): a payload field's annotation
comes ONLY from its declared ``field.<subType>`` + ``@isArray`` +
``@objectRef``, and its optionality ONLY from the declared ``@required`` attr.
Any ``origin.*`` child a field carries is IGNORED for typing — the field types
exactly as if the origin child were absent (a prompt's payload is a typed
projection the author DECLARES, so payload bloat shows up as a diff; matches
the origin-blind TS / C# reference emitters). The nested-payload closure
edge is ONLY a declared ``field.object @objectRef``; the nested class is
emitted into the SAME file (so callers ``from .<template>_payload import …``
once), exactly once per target even if multiple fields reference it (per-file
dedupe — see the Dedupe note below). Everything else falls back to
``type_map.py_type_for(field)``.

Generated file naming mirrors the output-parser convention:
``<snake_case(template_name)>_payload.py`` and the public model class is
``<template_name>Payload``. Resolution of ``@payloadRef`` to the underlying
``object.value`` is short-name based (same contract as the Kotlin reference).

Dedupe note: the nested-payload dedupe is **per-file**, not per-run. Each
template's payload module is self-contained, so when two templates reference
the same nested-object target, both files emit `PostPayload`. This
differs from Kotlin's cross-run dedupe — Kotlin emits each class to its OWN
`.kt` file (one-class-per-file via KotlinPoet), so a single `PostPayload.kt`
is enough; subsequent templates merely import it. Python's per-template
file emit makes cross-run dedupe a footgun (the second template would
reference an undefined `PostPayload` class), so each file owns its full
class graph.
"""
from __future__ import annotations

from collections.abc import Callable

from metaobjects.codegen.collision_names import (
    ERR_PAYLOAD_NAME_COLLISION,  # noqa: F401 — re-exported; tests import it from here
    assign_nested_names,
)
from metaobjects.codegen.constants import generated_header
from metaobjects.codegen.format import ruff_format
from metaobjects.codegen import type_map
from metaobjects.codegen.generator import EmittedFile, GenContext, Generator
from metaobjects.codegen.type_map import py_type_for
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.object.object_constants import (
    OBJECT_SUBTYPE_PROJECTION,
    OBJECT_SUBTYPE_VALUE,
)
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.template import template_constants as tc
from metaobjects.meta.template.meta_template import MetaTemplate
from metaobjects.naming_refs import resolve_object_ref
from metaobjects.shared.base_types import TYPE_SOURCE, TYPE_TEMPLATE
from metaobjects.shared.separators import PACKAGE_SEP

_GENERATOR_NAME = "payload-vo-generator"

# ADR-0044 backstop error code — re-exported (not redefined; see #228) from the
# shared `collision_names` module, which reuses the canonical `errors.ErrorCode`
# entry. Kept importable under this name for back-compat (tests import it from here).


# ---------------------------------------------------------------------------
# Naming helpers (snake_case mirrors the router/output-parser local helpers).
# ---------------------------------------------------------------------------


def _snake_case(name: str) -> str:
    """``NpcResponseOutput`` → ``npc_response_output``. PascalCase → snake_case
    with no acronym handling — matches the convention used by sibling generators."""
    out: list[str] = []
    for i, ch in enumerate(name):
        if ch.isupper() and i > 0:
            out.append("_")
        out.append(ch.lower())
    return "".join(out)


def payload_class_name(template_name: str) -> str:
    """``NpcResponseOutput`` → ``NpcResponseOutputPayload``.

    Mirrors Kotlin's ``templateShort + "Payload"`` and gives the output-parser
    generator a single, stable class name to import."""
    return f"{template_name}Payload"


def payload_module_name(template_name: str) -> str:
    """``NpcResponseOutput`` → ``npc_response_output_payload``. The module name
    used in the emitted file path AND the import statement from the parser."""
    return f"{_snake_case(template_name)}_payload"


def response_class_name(template_name: str) -> str:
    """``SupportAnswerPrompt`` → ``SupportAnswerPromptResponse``.

    ADR-0052 gives a responding prompt a SECOND strict record: ``@payloadRef``
    types the request it renders outbound, ``@responseRef`` the reply it parses,
    and the two are different shapes. This port's primary record is TEMPLATE-named
    (:func:`payload_class_name`), so the response record is template-named too —
    ONE naming convention in this generator rather than a template-derived name
    beside a value-object-derived one. Java's ``SpringNaming.responseName`` and
    Kotlin's ``KotlinNaming.responseName`` are the same call.

    (C# diverges deliberately: its records are named after the resolved VALUE
    OBJECT, so there the response record simply IS the VO's record.)"""
    return f"{template_name}Response"


def response_module_name(template_name: str) -> str:
    """``SupportAnswerPrompt`` → ``support_answer_prompt_response``.

    The response record gets its OWN module rather than joining
    ``<template>_payload.py``, for two reasons. (1) Strictness is per-module here:
    a ``template.prompt``'s REQUEST payload emits ``extra="forbid"`` (a mistyped
    render slot must fail at construction) while a reply record must tolerate
    unknown fields — one file cannot carry both defaults, and a value-object
    reachable from BOTH closures could only have one. (2) It keeps every existing
    model's ``<template>_payload.py`` byte-identical. Java and Kotlin land the
    response in its own file for the same reason (one record per file)."""
    return f"{_snake_case(template_name)}_response"


# ---------------------------------------------------------------------------
# Resolution helpers (ADR-0042 package-local — same contract as Kotlin).
# ---------------------------------------------------------------------------


def _pkg_of(node: MetaData) -> str:
    """The effective package of an object — its ``resolution_key()`` minus the
    trailing ``::<name>`` ("" for a root-level object). Derived from the resolution
    key so it is correct for BOTH loaded trees (file_default_package) and
    programmatically-built trees (package only on the root)."""
    key = node.resolution_key()
    i = key.rfind(PACKAGE_SEP)
    return "" if i == -1 else key[:i]


def resolve_payload_vo(root: MetaData, ref: str, referrer_pkg: str) -> MetaObject | None:
    """Resolve a ``@payloadRef`` to its payload shape, PACKAGE-LOCAL (ADR-0042) —
    the SAME canonical ``resolve_object_ref`` contract the loader's own
    ``_validate_templates`` pass already uses to validate this exact ref
    (``loader/validation_passes.py`` — an FQN resolves exactly; a bare ref resolves
    in the referrer's own package first, else a root-level object). Rejects
    entities and sourced projections — a template-level payload target is an
    ``object.value`` or sourceless ``object.projection`` (#210; same contract as
    Kotlin).

    *referrer_pkg* is the REFERENCING TEMPLATE's own effective package — pass
    ``_pkg_of(template)`` (this module's ancestor-walk-aware helper, via
    ``resolution_key()``), NOT the template's bare ``.package``/``.file_default_package``
    attrs directly: for any LOADER-PARSED tree the two are identical (every parsed
    node is stamped with ``file_default_package`` at parse time, so
    ``resolution_key()``'s ancestor-walk branch never fires — this is provably the
    SAME value the loader's own ``tpl.package or tpl.file_default_package or ""``
    computes), but ``_pkg_of`` is ALSO correct for the many hand-built (non-loader)
    ``MetaData`` trees this generator's own test suite constructs (package set only
    on an ancestor, never stamped onto every node) — the bare expression would
    wrongly resolve those to ``""``, breaking existing byte-identical output.

    #228 — this used to delegate to a flat, package-BLIND
    bare-name-anywhere-at-root scan: a bare ``@payloadRef`` colliding
    across packages resolved to whichever same-bare-named ``object.value`` happened
    to load first, regardless of which package the referencing template belonged
    to — a "wrong node" mismatch against the loader, which ALREADY validates this
    exact ref package-local. Now both agree.

    #210 — widened: a template-level payload target is an ``object.value`` OR a
    SOURCELESS ``object.projection`` (the loader enforces the same set; nested
    ``field.object @objectRef`` targets stay value-only)."""
    obj = resolve_object_ref(root, ref, referrer_pkg)
    if not isinstance(obj, MetaObject) or not is_legal_payload_target(obj):
        return None
    return obj


def is_legal_payload_target(obj: MetaData) -> bool:
    """#210 — a template-level payload target (``@payloadRef``/``@responseRef``) is
    an ``object.value`` OR a SOURCELESS ``object.projection`` ("sourceless" per the
    #248 persistability contract: no declared/inherited ``source.*`` child; a
    concrete projection cannot inherit one — ``ERR_PROJECTION_INHERITED_SOURCE``).
    Mirrors the loader's ``_is_legal_payload_target``."""
    if obj.sub_type == OBJECT_SUBTYPE_VALUE:
        return True
    if obj.sub_type != OBJECT_SUBTYPE_PROJECTION:
        return False
    # ADR-0039: resolving — a source anywhere in the extends chain binds the
    # projection to a backing store, which disqualifies it as a payload shape.
    return not any(c.type == TYPE_SOURCE for c in obj.children())


def is_field_required(field: MetaField) -> bool:
    """The single required-ness predicate the payload model uses to decide a field's
    optionality (``T`` vs ``T | None = None``). A field is required iff its EFFECTIVE
    ``@required`` attr is the boolean ``True`` — ``attrs().get()`` RESOLVES through the
    ``extends`` super chain (ADR-0039), matching the TS payload-codegen
    ``isFieldRequired`` (whose ``field.attr(...)`` read is likewise resolving) so the
    extract-tier mapper that constructs this payload can rely on the same boundary
    (no skew). A ``@required: "true"`` string therefore types optional in BOTH the
    payload and the mapper. The extractor generator imports THIS predicate.

    Note: this intentionally accepts ONLY the boolean ``True`` (matching the TS
    payload-codegen predicate), which DELIBERATELY differs from the runtime
    ``object_extract._is_required`` / ``fr010_field_mapping.is_required``, both of which
    additionally treat the string ``"true"`` as required. The payload type's optionality
    and the extractor mapper's None-guarding are kept in lockstep by sharing THIS
    predicate, so do not "reconcile" it with the runtime predicate."""
    return field.attrs().get(fc.FIELD_ATTR_REQUIRED) is True


def _resolve_object_field_type(
    field: MetaField,
    root: MetaData,
    nested_emit_queue: list[tuple[MetaObject, str]],
    emitted_nested_keys: set[str],
    name_map: dict[str, str],
) -> tuple[str, set[str]]:
    """A declared ``field.object`` (``@objectRef``) — resolve to the
    nested payload class (single) or ``list[...]`` (array). The class name comes
    from the ADR-0044 *name_map* (bare ``<Short>Payload`` when unique in the module
    closure, package-qualified on a cross-package short-name collision). The target
    VO is scheduled for in-file emission, deduped by ``resolution_key()`` (NOT
    ``fqn()``, which returns the bare name and would collapse two same-short-name
    VOs from different packages into one). Falls back to the bare type-map form when
    the ``@objectRef`` can't be resolved (defensive — loader validation gates it)."""
    ref = field.attrs().get(fc.FIELD_ATTR_OBJECT_REF)
    if not isinstance(ref, str) or not ref:
        return _fallback_type(field)
    # ADR-0042 — a nested @objectRef resolves in the DECLARING field's package
    # (correct for a field.object inherited via extends across packages); an FQN
    # resolves exactly. NO bare-tail short-name fallback that would bind a same-named
    # VO in the wrong package on a cross-package collision (#191). The declaring
    # package is taken from the parent object's resolution key so it is correct for
    # both loaded trees (file_default_package) and programmatic trees (root package).
    referrer_pkg = _pkg_of(field.parent) if field.parent is not None else ""
    target = resolve_object_ref(root, ref, referrer_pkg)
    if not isinstance(target, MetaObject):  # narrows MetaData|None -> MetaObject
        return _fallback_type(field)
    target_key = target.resolution_key()
    # name_map was populated by the ADR-0044 closure walk (pass 1/2), which visits
    # the identical targets; the fallback guards a defensive gap only.
    nested_class = name_map.get(target_key) or payload_class_name(target.name)
    if target_key not in emitted_nested_keys:
        emitted_nested_keys.add(target_key)
        nested_emit_queue.append((target, nested_class))
    if type_map.field_is_array(field):
        return f"list[{nested_class}]", set()
    return nested_class, set()


def _pascal(name: str) -> str:
    """``priority`` → ``Priority``; ``order_priority`` is left as-is segment-wise
    (only the leading char is upper-cased), matching the cross-port naming rule which
    PascalCases the bare field / super name (no snake-splitting)."""
    return name[:1].upper() + name[1:] if name else name


def _shared_enum_super(field: MetaField) -> MetaData | None:
    """The abstract ``field.enum`` super a field extends, or ``None``. A field whose
    ``@values`` is inherited from an abstract base enum collapses (cross-port) to a
    NAMED module alias keyed on the SUPER's name, so multiple fields sharing one
    abstract enum reuse a single ``<Super> = Literal[...]`` alias. An inline enum
    (no super) types inline."""
    sup = field.super_data
    if sup is not None and sup.sub_type == fc.FIELD_SUBTYPE_ENUM:
        return sup
    return None


def _enum_field_type(
    field: MetaField, enum_aliases: dict[str, str]
) -> tuple[str, set[str]] | None:
    """Resolve a ``field.enum`` annotation. Returns ``None`` for a non-enum field (the
    caller falls through to the generic path).

    * SHARED (extends an abstract ``field.enum``) → emit/reuse a module-level
      ``<Pascal(super.name)> = Literal[...]`` alias (deduped in *enum_aliases*) and
      reference it (``<Alias>`` / ``list[<Alias>]``).
    * INLINE (no super) → inline ``Literal[...]`` via ``py_type_for`` (no alias).
    * No effective ``@values`` → fall through to ``py_type_for`` (bare ``str``).
    """
    if field.sub_type != fc.FIELD_SUBTYPE_ENUM:
        return None
    values = type_map.effective_enum_values(field)
    if not values:
        pt = py_type_for(field)
        return pt.expr, set(pt.imports)
    sup = _shared_enum_super(field)
    if sup is None:
        # Inline enum — let py_type_for emit the inline Literal[...] (+ the import).
        pt = py_type_for(field)
        return pt.expr, set(pt.imports)
    alias = _pascal(sup.name)
    if alias not in enum_aliases:
        members = ", ".join(type_map._py_str_literal(v) for v in values)
        enum_aliases[alias] = f"Literal[{members}]"
    ref = f"list[{alias}]" if type_map.field_is_array(field) else alias
    return ref, {"from typing import Literal"}


def _fallback_type(field: MetaField) -> tuple[str, set[str]]:
    """Type-map fallback used when a ``field.object`` ref can't be resolved."""
    pt = py_type_for(field)
    return pt.expr, set(pt.imports)


def _resolve_field_type(
    field: MetaField,
    root: MetaData,
    nested_emit_queue: list[tuple[MetaObject, str]],
    emitted_nested_keys: set[str],
    enum_aliases: dict[str, str],
    name_map: dict[str, str],
) -> tuple[str, set[str]]:
    """Resolve the Python annotation for one payload-VO field from its
    DECLARATION only (#270): ``field.<subType>`` + ``@isArray`` + ``@objectRef``.
    Any ``origin.*`` child is IGNORED — the field types exactly as if the origin
    child were absent (matching the origin-blind TS / C# reference
    emitters). Falls back to ``type_map.py_type_for``."""
    # A declared ``field.object`` (``@objectRef``) → nested payload class
    # (single or list), emitted in the same file. This is the prompt-pillar
    # nested-payload case the extract tier maps onto; without it the payload would
    # reference an undefined bare entity name (Pydantic "not fully defined").
    if field.sub_type == fc.FIELD_SUBTYPE_OBJECT:
        return _resolve_object_field_type(
            field, root, nested_emit_queue, emitted_nested_keys, name_map
        )
    # A ``field.enum`` → Literal[...] (inline) or a named module alias (shared).
    enum_type = _enum_field_type(field, enum_aliases)
    if enum_type is not None:
        return enum_type
    pt = py_type_for(field)
    return pt.expr, set(pt.imports)


# ---------------------------------------------------------------------------
# ADR-0044 — collision-scoped nested-payload naming (three-pass pipeline).
#
# A payload module is a SINGLE self-contained file, so its declared
# `field.object @objectRef` closure is the collision domain (ADR-0044's "closure
# of the payload root(s) emitted into one artifact"). Two value-objects sharing a bare
# short name across packages (`acme::alpha::Note` + `acme::beta::Note`, both
# reachable from one payload) must emit as DISTINCT classes — the pre-ADR-0044
# code deduped by `fqn()` (which returns the BARE name here), collapsing them to
# one class, last-wins, silently dropping the second shape. Pass 1 collects the
# closure keyed by `resolution_key()` (the true package-qualified FQN); pass 2
# assigns names as a pure function of the closure (bare when unique, package-
# qualified on collision, hard fail on a still-colliding derived name); pass 3
# (the existing emit path) uses the name map for both declaration and reference.
#
# Pass 2 (:func:`assign_nested_names`) + its ``package_qualified_name`` helper are
# PROMOTED to ``metaobjects.codegen.collision_names`` (#228) so the extract/
# output-parser tier reuses this SAME naming pass rather than re-deriving one.
# ---------------------------------------------------------------------------


def _nested_target_of(field: MetaField, root: MetaData) -> MetaObject | None:
    """The nested-payload target VO a *field* contributes to the module closure,
    or ``None`` when it contributes no nested class. The ONLY closure edge is a
    declared ``field.object`` ``@objectRef`` (#270 — an ``origin.*`` child never
    contributes an edge; a non-object field contributes nothing). Mirrors the
    resolution in :func:`_resolve_object_field_type` EXACTLY, so the ADR-0044
    closure walk and the emission walk agree on the target set. The target's
    SUBTYPE is deliberately not constrained here — that matches the TS / C#
    reference emitters and this port's own extract-tier closure
    (``extract_delegate_emitter.reachable_vos``); the legal-target-set decision
    is #210's loader-validation call, not a codegen-tier fallback."""
    if field.sub_type != fc.FIELD_SUBTYPE_OBJECT:
        return None
    ref = field.attrs().get(fc.FIELD_ATTR_OBJECT_REF)
    if not isinstance(ref, str) or not ref:
        return None
    referrer_pkg = _pkg_of(field.parent) if field.parent is not None else ""
    target = resolve_object_ref(root, ref, referrer_pkg)
    return target if isinstance(target, MetaObject) else None


def _collect_nested_closure(
    root: MetaData,
    payload_vo: MetaObject,
    closure: dict[str, MetaObject],
    seen: set[str],
) -> None:
    """ADR-0044 pass 1 — walk *payload_vo*'s transitive nested-payload closure,
    collecting each target VO keyed by ``resolution_key()`` (never ``fqn()`` —
    which returns the bare name and would collapse a cross-package short-name
    collision). *seen* is seeded with the primary payload VO's key so the primary
    (which is named after the TEMPLATE, outside the VO-short-name collision
    domain) is never treated as a nested class, and doubles as the cycle guard."""
    for field in payload_vo.fields():
        if not isinstance(field, MetaField):
            continue
        target = _nested_target_of(field, root)
        if target is None:
            continue
        key = target.resolution_key()
        if key in seen:
            continue
        seen.add(key)
        closure[key] = target
        _collect_nested_closure(root, target, closure, seen)


# ---------------------------------------------------------------------------
# Class-block emission.
# ---------------------------------------------------------------------------


def _emit_payload_class(
    class_name: str,
    payload_vo: MetaObject,
    root: MetaData,
    nested_emit_queue: list[tuple[MetaObject, str]],
    emitted_nested_keys: set[str],
    extra_imports: set[str],
    enum_aliases: dict[str, str],
    docstring: str,
    name_map: dict[str, str],
) -> list[str]:
    """Build the source lines for one Pydantic ``BaseModel`` subclass."""
    lines: list[str] = [f"class {class_name}(BaseModel):", f'    """{docstring}"""']
    field_lines: list[str] = []
    for field in payload_vo.fields():
        if not isinstance(field, MetaField):
            continue
        annotation, imports = _resolve_field_type(
            field, root, nested_emit_queue, emitted_nested_keys, enum_aliases, name_map
        )
        extra_imports.update(imports)
        # Optionality mirrors the cross-port (TS) payload-codegen: a ``@required``
        # field is non-optional ``T``; everything else is ``T | None = None`` so the
        # strict payload can carry an absent optional value (and the extract-tier
        # mapper, which shares ``is_field_required``, agrees on the boundary).
        if is_field_required(field):
            field_lines.append(f"    {field.name}: {annotation}")
        else:
            field_lines.append(f"    {field.name}: {annotation} | None = None")
    if field_lines:
        lines.extend(field_lines)
    else:
        lines.append("    pass")
    return lines


def _with_strict_extras(block: list[str]) -> list[str]:
    """Insert ``model_config = ConfigDict(extra="forbid")`` into an emitted class block
    (right after its ``class …:`` line + docstring). Used for ``template.prompt`` input
    payloads so a mistyped field is rejected at construction rather than silently
    dropped — input is a strict contract. Response/output payloads keep the default
    (``extra="ignore"``) so they tolerate extra fields in an LLM/parsed payload."""
    body = block[2:]
    if body == ["    pass"]:  # an empty model — model_config makes the body non-empty
        body = []
    return [*block[:2], '    model_config = ConfigDict(extra="forbid")', *body]


def render_payload_vo(
    template: MetaTemplate,
    root: MetaData,
    *,
    generator: "PayloadVoGenerator | None" = None,
) -> str | None:
    """Render one payload module for a ``template.*`` node.

    When *generator* is supplied, its ``_emit_payload_class`` override is used for
    each emitted class (the extension seam). When ``None`` (the module-level
    back-compat call path), the module-level :func:`_emit_payload_class` is used —
    output is byte-identical to the pre-refactor behavior.

    Returns ``None`` when the ``@payloadRef`` can't be resolved to an
    ``object.value`` (defensive — the loader validation pass normally catches
    this first).

    Nested-payload dedupe is per-file: if the same ``field.object`` target
    appears twice within one payload module (two fields both ``@objectRef``-ing
    the same VO), only one nested class is emitted. Across
    different templates, each file owns its full class graph independently —
    see the module docstring for the rationale."""
    payload_ref = template.get_meta_attr(tc.TEMPLATE_ATTR_PAYLOAD_REF)  # ADR-0039: template attr resolves via extends (not origin; templates CAN extend)
    if not isinstance(payload_ref, str) or not payload_ref:
        return None
    # ADR-0042 (#228): the referrer is THIS template — a bare @payloadRef resolves
    # in ITS OWN package first.
    payload = resolve_payload_vo(root, payload_ref, _pkg_of(template))
    if payload is None:
        return None

    return _render_record_module(
        template,
        root,
        payload=payload,
        class_name=payload_class_name(template.name),
        primary_docstring=(
            f"GENERATED payload for template ``{template.name}``.\n\n"
            f"    Field shape derived from the ``{payload.name}`` object.value."
        ),
        # A template.prompt payload is the RENDER INPUT — make it reject unknown fields so a
        # mistyped slot fails at construction. Output/toolcall payloads are parse targets and
        # keep the tolerant default.
        strict_extras=template.sub_type == tc.TEMPLATE_SUBTYPE_PROMPT,
        generator=generator,
    )


def render_response_vo(
    template: MetaTemplate,
    root: MetaData,
    *,
    generator: "PayloadVoGenerator | None" = None,
) -> str | None:
    """Render the ADR-0052 RESPONSE record module for a responding ``template.prompt``.

    ``None`` when the template declares no ``@responseRef`` or the ref does not
    resolve — i.e. for every template that is not a responding prompt, which is the
    normal case and never a warning.

    The record is the shape the generated parser RETURNS. It is NOT the prompt's
    ``@payloadRef``, which types the request rendered outbound; emitting only the
    request record would leave ``output_parser_generator`` importing a class nobody
    declares. Unlike the request payload it keeps Pydantic's tolerant
    ``extra="ignore"`` default — a model's reply is not a contract this side
    controls, and the strict/tolerant tiers each have their own way of reporting a
    field that is missing."""
    # Deferred import: ``find_inbound`` imports ``resolve_payload_vo`` from THIS
    # module (the direction rule must resolve a response through the same target
    # rule ``@payloadRef`` obeys), so a module-level import here would be a cycle.
    from metaobjects.codegen.generators.find_inbound import response_shape

    shape = response_shape(root, template, _pkg_of(template))
    if shape is None:
        return None
    return _render_record_module(
        template,
        root,
        payload=shape.vo,
        class_name=response_class_name(template.name),
        primary_docstring=(
            f"GENERATED response shape for template.prompt ``{template.name}``.\n\n"
            f"    Field shape derived from the ``{shape.vo.name}`` object.value."
        ),
        strict_extras=False,
        generator=generator,
    )


def _render_record_module(
    template: MetaTemplate,
    root: MetaData,
    *,
    payload: MetaObject,
    class_name: str,
    primary_docstring: str,
    strict_extras: bool,
    generator: "PayloadVoGenerator | None",
) -> str:
    """Render one self-contained record module: the PRIMARY class *class_name*
    modelling *payload*, plus a class for every value-object in its declared
    ``field.object @objectRef`` closure.

    Shared by :func:`render_payload_vo` (the ``@payloadRef`` request record) and
    :func:`render_response_vo` (the ADR-0052 ``@responseRef`` reply record) — the
    two differ only in which VO roots the closure, what the primary class is called,
    and whether unknown fields are rejected."""
    # ADR-0044 pass 1/2 — the collision domain is this module's nested-payload
    # closure. Seed `seen` with the primary VO's key so the primary (named after
    # the TEMPLATE, not the VO) stays out of the VO-short-name collision domain.
    closure: dict[str, MetaObject] = {}
    _collect_nested_closure(root, payload, closure, {payload.resolution_key()})
    name_map = assign_nested_names(closure, payload_class_name)

    # Per-file dedupe set: scoped to this single render call so each emitted
    # module is self-contained (no cross-template forward references). Keyed by
    # ``resolution_key()`` (see _resolve_object_field_type) so two same-short-name
    # VOs from different packages both emit.
    emitted_nested_keys: set[str] = set()
    extra_imports: set[str] = set()
    nested_emit_queue: list[tuple[MetaObject, str]] = []
    # Shared-enum aliases (``<Pascal(super.name)> = Literal[...]``), deduped by name and
    # emitted once at module scope before the classes that reference them.
    enum_aliases: dict[str, str] = {}

    # The class-block emitter: the generator's overridable hook when an instance is
    # supplied, else the module-level default (byte-identical back-compat path).
    emit_class = generator._emit_payload_class if generator is not None else _emit_payload_class

    # The PRIMARY class (the one named after the template). Its docstring
    # mirrors Kotlin's KDoc.
    primary_block = emit_class(
        class_name=class_name,
        payload_vo=payload,
        root=root,
        nested_emit_queue=nested_emit_queue,
        emitted_nested_keys=emitted_nested_keys,
        extra_imports=extra_imports,
        enum_aliases=enum_aliases,
        docstring=primary_docstring,
        name_map=name_map,
    )
    if strict_extras:
        primary_block = _with_strict_extras(primary_block)

    # NESTED classes scheduled by declared `field.object @objectRef` fields.
    # Drain the queue iteratively so nested-of-nested chains also get emitted
    # (Kotlin behaves the same way — the recursive emit is queue-driven here
    # for clarity).
    nested_blocks: list[list[str]] = []
    nested_class_names: list[str] = []
    while nested_emit_queue:
        target, nested_class = nested_emit_queue.pop(0)
        block = emit_class(
            class_name=nested_class,
            payload_vo=target,
            root=root,
            nested_emit_queue=nested_emit_queue,
            emitted_nested_keys=emitted_nested_keys,
            extra_imports=extra_imports,
            enum_aliases=enum_aliases,
            docstring=(
                f"GENERATED nested payload for object field target ``{target.name}``."
            ),
            name_map=name_map,
        )
        if strict_extras:
            block = _with_strict_extras(block)
        nested_blocks.append(block)
        nested_class_names.append(nested_class)

    # Build the file. Module FQN follows the convention used by sibling
    # generators (entity_model._effective_fqn) — package from nearest ancestor.
    fqn = _effective_fqn_for(template, payload)
    lines: list[str] = [generated_header(template.name, fqn), "from __future__ import annotations\n"]
    for imp in sorted(extra_imports):
        lines.append(imp)
    if extra_imports:
        lines.append("")
    lines.append(
        "from pydantic import BaseModel, ConfigDict" if strict_extras else "from pydantic import BaseModel"
    )
    lines.append("")
    lines.append("")
    # Shared-enum aliases (module scope, deduped, sorted for deterministic output).
    # Referenced by one OR MORE payload fields that extend the same abstract field.enum.
    if enum_aliases:
        for alias in sorted(enum_aliases):
            lines.append(f"{alias} = {enum_aliases[alias]}")
        lines.append("")
        lines.append("")
    # Emit nested classes FIRST. Pydantic v2 with `from __future__ import
    # annotations` evaluates field annotations lazily, but it needs every
    # referenced class to be defined in the module namespace at model-build
    # time — otherwise it raises PydanticUserError("not fully defined") and
    # callers would have to run model_rebuild(). Nested-first avoids that.
    for block in nested_blocks:
        lines.extend(block)
        lines.append("")
        lines.append("")
    lines.extend(primary_block)
    lines.append("")
    lines.append("")
    all_names = [class_name, *nested_class_names]
    quoted = ", ".join(f'"{n}"' for n in all_names)
    lines.append(f"__all__ = [{quoted}]")
    lines.append("")
    return "\n".join(lines)


def _effective_fqn_for(template: MetaTemplate, payload: MetaObject) -> str:
    """``package::name`` for the doc-header, via the canonical
    :meth:`MetaData.resolution_key` (own package, else the file-default captured at
    parse, else the nearest ancestor) — multi-file-merge safe. Falls back to the
    payload's package only if the template resolves to a bare (package-less) name."""
    key = template.resolution_key()
    if PACKAGE_SEP in key:
        return key
    payload_pkg = payload.package or payload.file_default_package
    return f"{payload_pkg}{PACKAGE_SEP}{template.name}" if payload_pkg else template.name


# ---------------------------------------------------------------------------
# Generator wrapper.
# ---------------------------------------------------------------------------


class PayloadVoGenerator:
    """Generator wrapping ``render_payload_vo``. Emits one ``<template>_payload.py``
    per declared ``template.*`` (prompt / output / toolcall) — iterates ALL template
    subtypes uniformly to match the Kotlin reference (no subtype filter) — plus, for
    a responding ``template.prompt`` (ADR-0052), a second ``<template>_response.py``
    holding the reply record its generated parser returns."""

    name = _GENERATOR_NAME

    def __init__(self, *, filter: Callable[[MetaObject], bool] | None = None) -> None:
        # The ``filter`` arg matches the cross-generator contract even though
        # this generator iterates templates (not entities).
        self.filter = filter

    def _emit_payload_class(
        self,
        class_name: str,
        payload_vo: MetaObject,
        root: MetaData,
        nested_emit_queue: list[tuple[MetaObject, str]],
        emitted_nested_keys: set[str],
        extra_imports: set[str],
        enum_aliases: dict[str, str],
        docstring: str,
        name_map: dict[str, str],
    ) -> list[str]:
        """EXTENSION SEAM — the source lines for one Pydantic ``BaseModel`` subclass
        (primary OR a nested object-field target). Defaults to the module-level
        :func:`_emit_payload_class`; override to customize the emitted class body
        (e.g. inject ``model_config``, change optionality, add validators)."""
        return _emit_payload_class(
            class_name,
            payload_vo,
            root,
            nested_emit_queue,
            emitted_nested_keys,
            extra_imports,
            enum_aliases,
            docstring,
            name_map,
        )

    def _render_module(self, template: MetaTemplate, root: MetaData) -> str | None:
        """EXTENSION SEAM — render the whole payload module for one ``template.*``.
        Defaults to :func:`render_payload_vo` (passing this instance so the
        ``_emit_payload_class`` override is honored). Override to pre/post-process
        the emitted source, or replace the render path entirely."""
        return render_payload_vo(template, root, generator=self)

    def _render_response_module(
        self, template: MetaTemplate, root: MetaData
    ) -> str | None:
        """EXTENSION SEAM — render the ADR-0052 response-record module for one
        responding ``template.prompt``, or ``None`` when the template declares no
        resolvable ``@responseRef``. Defaults to :func:`render_response_vo`."""
        return render_response_vo(template, root, generator=self)

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        root = ctx.loaded_root
        if root is None:
            return []
        files: list[EmittedFile] = []
        # ADR-0039 sanctioned own: top-level template scan on the loader ROOT
        # (metadata.root is never extended, so own == effective).
        templates = sorted(
            (c for c in root.own_children() if c.type == TYPE_TEMPLATE and isinstance(c, MetaTemplate)),
            key=lambda c: c.name,
        )
        # Nested-payload dedupe is per-file (inside render_payload_vo). Each
        # template's emitted module is self-contained — see module docstring.
        for tmpl in templates:
            content = self._render_module(tmpl, root)
            if content is None:
                ctx.warn(
                    f"{_GENERATOR_NAME}: skipping template "
                    f"'{tmpl.name}' (no resolvable @payloadRef to an object.value)."
                )
            else:
                files.append(
                    EmittedFile(
                        path=f"{payload_module_name(tmpl.name)}.py",
                        content=ruff_format(content),
                    )
                )
            # ADR-0052 — the INBOUND half. A responding prompt's @responseRef names the
            # shape its generated parser RETURNS, so that shape needs a strict record of
            # its own, in its own module (see response_module_name). Silent when absent:
            # not being a responding prompt is the normal case, not a skipped emission.
            response = self._render_response_module(tmpl, root)
            if response is not None:
                files.append(
                    EmittedFile(
                        path=f"{response_module_name(tmpl.name)}.py",
                        content=ruff_format(response),
                    )
                )
        return files


def payload_vo_generator(
    *, filter: Callable[[MetaObject], bool] | None = None
) -> Generator:
    """Factory mirroring the TS / C# / Kotlin payload-VO generators."""
    return PayloadVoGenerator(filter=filter)
