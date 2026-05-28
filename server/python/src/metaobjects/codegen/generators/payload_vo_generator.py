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
types are origin-aware: a payload-VO field may carry an ``origin.*`` child that
declares how the value is derived, and the field's annotation is resolved as:

* ``origin.passthrough`` (``@from "Entity.field"``) — type of the source field.
* ``origin.aggregate``  (``@agg count``)              — ``int``.
                        (``@agg avg``)                — ``float``.
                        (``@agg sum``/``min``/``max``) — type of ``@of`` field.
* ``origin.collection`` (``@via "Parent.relName"``)   — ``list[<TargetShortName>Payload]``,
  and the nested ``<TargetShortName>Payload`` is emitted into the SAME file
  (so callers ``from .<template>_payload import …`` once). Nested payloads
  are deduped across the whole run by the resolved target FQN.
* No origin child — fall back to ``type_map.py_type_for(field)``.

Generated file naming mirrors the output-parser convention:
``<snake_case(template_name)>_payload.py`` and the public model class is
``<template_name>Payload``. Resolution of ``@payloadRef`` to the underlying
``object.value`` is short-name based (same contract as the Kotlin reference).

Dedupe note: the nested-payload dedupe is **per-file**, not per-run. Each
template's payload module is self-contained, so when two templates reference
the same `origin.collection` target, both files emit `PostPayload`. This
differs from Kotlin's cross-run dedupe — Kotlin emits each class to its OWN
`.kt` file (one-class-per-file via KotlinPoet), so a single `PostPayload.kt`
is enough; subsequent templates merely import it. Python's per-template
file emit makes cross-run dedupe a footgun (the second template would
reference an undefined `PostPayload` class), so each file owns its full
class graph.
"""
from __future__ import annotations

from collections.abc import Callable

from metaobjects.codegen.constants import generated_header
from metaobjects.codegen.format import ruff_format
from metaobjects.codegen.generator import EmittedFile, GenContext, Generator
from metaobjects.codegen.type_map import py_type_for
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.object.object_constants import OBJECT_SUBTYPE_VALUE
from metaobjects.meta.core.relationship.meta_relationship import MetaRelationship
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.persistence.origin.meta_origin import MetaOrigin
from metaobjects.meta.persistence.origin.origin_constants import (
    ORIGIN_ATTR_AGG,
    ORIGIN_ATTR_FROM,
    ORIGIN_ATTR_OF,
    ORIGIN_ATTR_VIA,
)
from metaobjects.meta.template import template_constants as tc
from metaobjects.meta.template.meta_template import MetaTemplate
from metaobjects.shared.base_types import TYPE_OBJECT, TYPE_TEMPLATE
from metaobjects.shared.separators import PACKAGE_SEP

_GENERATOR_NAME = "payload-vo-generator"


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


# ---------------------------------------------------------------------------
# Resolution helpers (lookup by short-name OR FQN — same contract as Kotlin).
# ---------------------------------------------------------------------------


def _resolve_object_by_short_or_fqn(root: MetaData, ref: str) -> MetaObject | None:
    """Find a ``MetaObject`` child by short-name match.

    Equivalent contract to ``KotlinGenUtil.resolveObjectByShortOrFqn``, but
    simpler in Python: ``MetaData.name`` only ever holds the short name (the
    package lives on ``MetaData.package`` and ``fqn()`` builds the dotted
    form on demand). So a plain ``child.name == ref`` is enough.

    ``ref`` is the value passed in ``@payloadRef`` / ``@objectRef`` /
    ``origin.@from``, which by spec is the short name of the target object."""
    for child in root.own_children():
        if child.type != TYPE_OBJECT or not isinstance(child, MetaObject):
            continue
        if child.name == ref:
            return child
    return None


def resolve_payload_vo(root: MetaData, ref: str) -> MetaObject | None:
    """Resolve a ``@payloadRef`` to its ``object.value``. Rejects entities —
    payloads MUST be value-objects (same contract as Kotlin)."""
    obj = _resolve_object_by_short_or_fqn(root, ref)
    if obj is None or obj.sub_type != OBJECT_SUBTYPE_VALUE:
        return None
    return obj


def _split_dotted_ref(ref: str) -> tuple[str, str] | None:
    """``"Entity.field"`` → ``("Entity", "field")``. Returns ``None`` for
    no-dot / leading-dot / trailing-dot — same contract as Kotlin."""
    dot = ref.find(".")
    if dot <= 0 or dot >= len(ref) - 1:
        return None
    return ref[:dot], ref[dot + 1 :]


def _resolve_dotted_field_ref(root: MetaData, dotted_ref: str) -> MetaField | None:
    """Resolve ``"Entity.field"`` to the ``MetaField`` on ``Entity`` (by short
    name OR FQN-trailing-segment match). Returns ``None`` if either half fails."""
    parts = _split_dotted_ref(dotted_ref)
    if parts is None:
        return None
    entity_name, field_name = parts
    obj = _resolve_object_by_short_or_fqn(root, entity_name)
    if obj is None:
        return None
    for f in obj.fields():
        if not isinstance(f, MetaField):
            continue
        if f.name == field_name:
            return f
    return None


def _find_origin_child(field: MetaField) -> MetaOrigin | None:
    """First ``origin.*`` child of *field* (own children only — origins are
    declared inline; there's no inheritance contract for them today)."""
    for c in field.own_children():
        if isinstance(c, MetaOrigin):
            return c
    return None


def _find_relationship_on(obj: MetaObject, rel_name: str) -> MetaRelationship | None:
    """Resolve a relationship by name on *obj*. Walks effective children so
    inherited relationships are visible."""
    for c in obj.children():
        if isinstance(c, MetaRelationship) and c.name == rel_name:
            return c
    return None


# ---------------------------------------------------------------------------
# Origin-aware field-type resolution.
# ---------------------------------------------------------------------------


def _resolve_passthrough_type(
    origin: MetaOrigin, root: MetaData, fallback: MetaField
) -> tuple[str, set[str]]:
    """``origin.passthrough @from "Entity.field"`` — resolve to source field's
    Python type. Falls back to the payload field's own type when the dotted
    ref can't be resolved (defensive — loader validation already gates ``@from``)."""
    from_ref = origin.attr(ORIGIN_ATTR_FROM)
    if not isinstance(from_ref, str) or not from_ref:
        return _fallback_type(fallback)
    source = _resolve_dotted_field_ref(root, from_ref)
    if source is None:
        return _fallback_type(fallback)
    pt = py_type_for(source)
    return pt.expr, set(pt.imports)


def _resolve_aggregate_type(
    origin: MetaOrigin, root: MetaData, fallback: MetaField
) -> tuple[str, set[str]]:
    """``origin.aggregate``: type rule —
    - count → ``int``
    - avg   → ``float``
    - sum / min / max → type of the ``@of`` field
    """
    agg = origin.attr(ORIGIN_ATTR_AGG)
    if agg == "count":
        return "int", set()
    if agg == "avg":
        return "float", set()
    if agg in ("sum", "min", "max"):
        of_ref = origin.attr(ORIGIN_ATTR_OF)
        if not isinstance(of_ref, str) or not of_ref:
            return _fallback_type(fallback)
        source = _resolve_dotted_field_ref(root, of_ref)
        if source is None:
            return _fallback_type(fallback)
        pt = py_type_for(source)
        return pt.expr, set(pt.imports)
    return _fallback_type(fallback)


def _resolve_collection_type(
    origin: MetaOrigin,
    root: MetaData,
    fallback: MetaField,
    nested_emit_queue: list[tuple[MetaObject, str]],
    emitted_nested_fqns: set[str],
) -> tuple[str, set[str]]:
    """``origin.collection @via "Parent.rel"`` — walk Parent's relationship to
    its ``@objectRef`` target, schedule a nested ``<TargetShortName>Payload``
    for in-file emission, return ``list[<TargetShortName>Payload]``.

    Dedupe is per-file via *emitted_nested_fqns* — if the same target is
    referenced by two fields in the same payload module, only one nested
    class is emitted. Cross-file dedupe would leave forward-references
    dangling (see the module docstring)."""
    via = origin.attr(ORIGIN_ATTR_VIA)
    if not isinstance(via, str) or not via:
        return _fallback_type(fallback)
    parts = _split_dotted_ref(via)
    if parts is None:
        return _fallback_type(fallback)
    parent_name, rel_name = parts
    parent = _resolve_object_by_short_or_fqn(root, parent_name)
    if parent is None:
        return _fallback_type(fallback)
    rel = _find_relationship_on(parent, rel_name)
    if rel is None:
        return _fallback_type(fallback)
    target_ref = rel.object_ref()
    if not target_ref:
        return _fallback_type(fallback)
    target = _resolve_object_by_short_or_fqn(root, target_ref)
    if target is None:
        return _fallback_type(fallback)
    # MetaData.name is the short name (no `::`); see _resolve_object_by_short_or_fqn.
    nested_class = payload_class_name(target.name)
    target_fqn = target.fqn()
    if target_fqn not in emitted_nested_fqns:
        emitted_nested_fqns.add(target_fqn)
        nested_emit_queue.append((target, nested_class))
    return f"list[{nested_class}]", set()


def _fallback_type(field: MetaField) -> tuple[str, set[str]]:
    """Type-map fallback used by every origin path when resolution fails."""
    pt = py_type_for(field)
    return pt.expr, set(pt.imports)


def _resolve_field_type(
    field: MetaField,
    root: MetaData,
    nested_emit_queue: list[tuple[MetaObject, str]],
    emitted_nested_fqns: set[str],
) -> tuple[str, set[str]]:
    """Resolve the Python annotation for one payload-VO field, honoring any
    ``origin.*`` child. Falls back to ``type_map.py_type_for`` when none.

    Note: a payload-VO field declared as ``field.object`` (with ``@objectRef``)
    but no origin child falls through to ``type_map.py_type_for``, which emits
    the entity short-name as a forward-reference string. The entity model is
    NOT auto-imported — payload modules and entity modules may live in
    different output directories, and the consumer is expected to wire
    cross-module imports explicitly. The metadata-driven path for "this VO
    field is a foreign-object value" is ``origin.collection`` (nested payload)
    or ``origin.passthrough`` (scalar projection)."""
    origin = _find_origin_child(field)
    if origin is None:
        pt = py_type_for(field)
        return pt.expr, set(pt.imports)
    if origin.sub_type == "passthrough":
        return _resolve_passthrough_type(origin, root, field)
    if origin.sub_type == "aggregate":
        return _resolve_aggregate_type(origin, root, field)
    if origin.sub_type == "collection":
        return _resolve_collection_type(
            origin, root, field, nested_emit_queue, emitted_nested_fqns
        )
    return _fallback_type(field)


# ---------------------------------------------------------------------------
# Class-block emission.
# ---------------------------------------------------------------------------


def _emit_payload_class(
    class_name: str,
    payload_vo: MetaObject,
    root: MetaData,
    nested_emit_queue: list[tuple[MetaObject, str]],
    emitted_nested_fqns: set[str],
    extra_imports: set[str],
    docstring: str,
) -> list[str]:
    """Build the source lines for one Pydantic ``BaseModel`` subclass."""
    lines: list[str] = [f"class {class_name}(BaseModel):", f'    """{docstring}"""']
    field_lines: list[str] = []
    for field in payload_vo.fields():
        if not isinstance(field, MetaField):
            continue
        annotation, imports = _resolve_field_type(
            field, root, nested_emit_queue, emitted_nested_fqns
        )
        extra_imports.update(imports)
        field_lines.append(f"    {field.name}: {annotation}")
    if field_lines:
        lines.extend(field_lines)
    else:
        lines.append("    pass")
    return lines


def render_payload_vo(
    template: MetaTemplate,
    root: MetaData,
) -> str | None:
    """Render one payload module for a ``template.*`` node.

    Returns ``None`` when the ``@payloadRef`` can't be resolved to an
    ``object.value`` (defensive — the loader validation pass normally catches
    this first).

    Nested-payload dedupe is per-file: if the same collection target appears
    twice within one payload module (e.g. two fields both `origin.collection`
    on the same relationship), only one nested class is emitted. Across
    different templates, each file owns its full class graph independently —
    see the module docstring for the rationale."""
    payload_ref = template.attr(tc.TEMPLATE_ATTR_PAYLOAD_REF)
    if not isinstance(payload_ref, str) or not payload_ref:
        return None
    payload = resolve_payload_vo(root, payload_ref)
    if payload is None:
        return None

    # Per-file dedupe set: scoped to this single render call so each emitted
    # module is self-contained (no cross-template forward references).
    emitted_nested_fqns: set[str] = set()
    class_name = payload_class_name(template.name)
    extra_imports: set[str] = set()
    nested_emit_queue: list[tuple[MetaObject, str]] = []

    # The PRIMARY class (the one named after the template). Its docstring
    # mirrors Kotlin's KDoc.
    primary_block = _emit_payload_class(
        class_name=class_name,
        payload_vo=payload,
        root=root,
        nested_emit_queue=nested_emit_queue,
        emitted_nested_fqns=emitted_nested_fqns,
        extra_imports=extra_imports,
        docstring=(
            f"GENERATED payload for template ``{template.name}``.\n\n"
            f"    Field shape derived from the ``{payload.name}`` object.value."
        ),
    )

    # NESTED classes scheduled by origin.collection. Drain the queue
    # iteratively so nested-of-nested chains also get emitted (Kotlin behaves
    # the same way — the recursive emit is queue-driven here for clarity).
    nested_blocks: list[list[str]] = []
    nested_class_names: list[str] = []
    while nested_emit_queue:
        target, nested_class = nested_emit_queue.pop(0)
        block = _emit_payload_class(
            class_name=nested_class,
            payload_vo=target,
            root=root,
            nested_emit_queue=nested_emit_queue,
            emitted_nested_fqns=emitted_nested_fqns,
            extra_imports=extra_imports,
            docstring=(
                f"GENERATED nested payload for collection target ``{target.name}``."
            ),
        )
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
    lines.append("from pydantic import BaseModel")
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
    """``package::name`` for the doc-header. Prefer the template's own package
    chain; fall back to the payload's; finally the bare template name."""

    def _walk(node: MetaData) -> str | None:
        pkg = node.package
        parent = node.parent
        while pkg is None and parent is not None:
            pkg = parent.package
            parent = parent.parent
        return pkg

    pkg = _walk(template) or _walk(payload)
    return f"{pkg}{PACKAGE_SEP}{template.name}" if pkg else template.name


# ---------------------------------------------------------------------------
# Generator wrapper.
# ---------------------------------------------------------------------------


class PayloadVoGenerator:
    """Generator wrapping ``render_payload_vo``. Emits one file per declared
    ``template.*`` (prompt / output / toolcall) — iterates ALL template
    subtypes uniformly to match the Kotlin reference (no subtype filter)."""

    name = _GENERATOR_NAME

    def __init__(self, *, filter: Callable[[MetaObject], bool] | None = None) -> None:
        # The ``filter`` arg matches the cross-generator contract even though
        # this generator iterates templates (not entities).
        self.filter = filter

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        root = ctx.loaded_root
        if root is None:
            return []
        files: list[EmittedFile] = []
        templates = sorted(
            (c for c in root.own_children() if c.type == TYPE_TEMPLATE and isinstance(c, MetaTemplate)),
            key=lambda c: c.name,
        )
        # Nested-payload dedupe is per-file (inside render_payload_vo). Each
        # template's emitted module is self-contained — see module docstring.
        for tmpl in templates:
            content = render_payload_vo(tmpl, root)
            if content is None:
                ctx.warn(
                    f"{_GENERATOR_NAME}: skipping template "
                    f"'{tmpl.name}' (no resolvable @payloadRef to an object.value)."
                )
                continue
            files.append(
                EmittedFile(
                    path=f"{payload_module_name(tmpl.name)}.py",
                    content=ruff_format(content),
                )
            )
        return files


def payload_vo_generator(
    *, filter: Callable[[MetaObject], bool] | None = None
) -> Generator:
    """Factory mirroring the TS / C# / Kotlin payload-VO generators."""
    return PayloadVoGenerator(filter=filter)
