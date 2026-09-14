"""M:N junction FK derivation — the single source of truth for which junction
columns are the SOURCE side and the TARGET side of a many-to-many relationship.

A M:N relationship (``@cardinality: "many"``, ``@objectRef: <target>``,
``@through: <junction>``) does NOT restate its FK columns. They are derived from
the junction entity's two ``identity.reference`` children — one resolving to the
source entity, one to the target — exactly as 1:N FK direction is declared.

Three modes (see the FR-018 design + the TS reference ``derive-m2m-fields.ts``):
  1. Hetero (source != target): the reference resolving to the source entity
     gives source_field; the one resolving to the target gives target_field.
  2. Directed self-join (source == target, @sourceRefField set): both references
     resolve to the same entity, so @sourceRefField names the source-side FK
     field; the OTHER reference is the target side.
  3. Symmetric self-join (source == target, @symmetric: true): undirected; the
     two references are taken in declaration order (source_field = first,
     target_field = second). Resolution unions both at read time.
Ambiguous (source == target, neither @sourceRefField nor @symmetric) → raise.

"source" above means the relationship's SUBJECT, and under ``extends`` there are two
legitimate names for it. Every caller walks a RESOLVING accessor —
``resolve_n2m_descriptor`` over ``children()``, ``m2m_codegen.m2m_relationships`` over
``entity.children()`` — and passes the entity it is ITERATING, which for an inherited
relationship is not the one that declared it. So the DECLARING entity is resolved here
from ``rel.parent`` (same shape as the #368 loader fix, ``validation_passes``'
``declaring_entity = rel.parent if rel.parent is not None else obj``), and the passed
``source`` is kept alongside it rather than discarded: a junction FK usually references
the CONCRETE entity, because the abstract base has no table, while ``@objectRef`` on an
inherited self-join names the base. Both are accepted, for the self-join classification
and the hetero reference match alike. ``source`` is also the fallback when ``rel`` has no
object parent, which keeps the signature unchanged. Not covered: a junction reference
naming an entity strictly BETWEEN the base and the navigating entity in a deeper
hierarchy.

The subject comparison is made on RESOLVED OBJECT IDENTITY, not on stripped short
names, matching the Java reference (``M2MFields.java``). Bare-name equality cannot
tell ``a::NodeBase`` from ``b::NodeBase``, so once the subject set held two names a
genuine CROSS-PACKAGE hetero M:N whose target shares a short name with the subject
read as a self-join and refused to derive. Scoped deliberately to this one predicate
— every other name comparison in this module is untouched.
"""
from __future__ import annotations

from dataclasses import dataclass

from ...meta_data import MetaData
from ....shared.base_types import TYPE_IDENTITY, TYPE_OBJECT
from ....shared.separators import PACKAGE_SEP
from ..identity.identity_constants import (
    IDENTITY_ATTR_FIELDS,
    IDENTITY_REFERENCE_ATTR_REFERENCES,
    IDENTITY_SUBTYPE_REFERENCE,
)
from .meta_relationship import MetaRelationship
from .relationship_references import reference_target_entity


class M2MDerivationError(Exception):
    """Raised when a M:N relationship's junction FK fields cannot be derived."""

    code = "ERR_INVALID_RELATIONSHIP"


@dataclass(frozen=True)
class M2MFields:
    """The derived source/target junction FK fields for a M:N relationship."""

    source_field: str
    target_field: str


def _strip_package(name: str) -> str:
    """Return the bare object name from a (possibly package-qualified) reference."""
    idx = name.rfind(PACKAGE_SEP)
    return name[idx + len(PACKAGE_SEP):] if idx >= 0 else name


def _reference_children(junction: MetaData) -> list[MetaData]:
    """The junction's identity.reference children (declaration order).

    ADR-0039 — RESOLVING (``children()``): mirrors the TS
    ``junction.referenceIdentities()`` (built over the effective ``identities()``),
    so a junction inheriting an ``identity.reference`` via ``extends`` is honored.
    """
    return [
        c
        for c in junction.children()
        if c.type == TYPE_IDENTITY and c.sub_type == IDENTITY_SUBTYPE_REFERENCE
    ]


def _ref_fk_field(ref: MetaData) -> str | None:
    """First @fields entry of a reference (the physical FK column on the junction)."""
    fields = ref.get_meta_attr(IDENTITY_ATTR_FIELDS)  # ADR-0039: resolving (identity attr)
    if isinstance(fields, (list, tuple)) and fields:
        first = fields[0]
        return first if isinstance(first, str) else None
    if isinstance(fields, str) and fields:
        return fields.split(",")[0].strip() or None
    return None


def _ref_target_entity(ref: MetaData) -> str | None:
    """The @references target-entity name of a reference (bare, package-stripped).

    Compares the WHOLE @references value, so the dotted ``Entity.field`` form
    ("Team.id") never matches a bare entity name. That blind spot NO LONGER
    affects M:N derivation: both junction matches now run through
    :func:`_ref_target_qualified` (which delegates to the canonical
    ``reference_target_entity``), and this function is reached only on the
    DEFENSIVE fallback path — when ``@objectRef`` does not resolve to an entity at
    all, which loader validation normally prevents. It is left package-stripped
    because that fallback is deliberately the pre-identity behaviour; the
    remaining copy of the dotted blind spot is being closed on its own branch.
    """
    v = ref.get_meta_attr(IDENTITY_REFERENCE_ATTR_REFERENCES)  # ADR-0039: resolving (identity attr)
    return _strip_package(v) if isinstance(v, str) and v else None


def _ref_target_qualified(ref: MetaData) -> str | None:
    """The target-entity half of a reference's ``@references``, PACKAGE INTACT.

    Distinct from :func:`_ref_target_entity`, which strips the package for the
    legacy bare-name compare. Identity resolution needs the qualified form to tell
    ``a::NodeBase`` from ``b::NodeBase``, and needs the dotted ``Entity.field``
    form reduced to its entity head — which is exactly what the canonical
    :func:`~metaobjects.meta.core.relationship.relationship_references.reference_target_entity`
    already computes, so this delegates rather than keeping a third copy of the
    parse. That helper searches the dot only AFTER the last ``::``, so a package
    segment can never be mistaken for the field separator; a local ``find(".")``
    would have assumed packages never contain a dot instead of declining the
    assumption.

    Delegating also finishes the seam with the branch that makes
    :func:`_ref_target_entity` split: one parse, one behaviour, both sides of the
    same ``if``.
    """
    return reference_target_entity(ref)


def _root_objects(node: MetaData) -> list[MetaData]:
    """Every top-level object of the tree *node* belongs to, in declaration order.

    Walks up to the root rather than taking the caller's ``object_index``: that
    index is keyed by BARE name, so two same-short-name entities in different
    packages collapse to one entry and FQN-exact resolution is impossible from it.
    """
    root = node
    while root.parent is not None:
        root = root.parent
    return [c for c in root.children() if c.type == TYPE_OBJECT]


def _find_entity(objects: list[MetaData], name: str | None) -> MetaData | None:
    """The root entity a reference name denotes, or ``None``.

    Mirrors the Java reference's ``M2MFields.findObject`` exactly: a FULLY-QUALIFIED
    name (one containing ``::``) resolves EXACTLY on the object's package-folded key,
    never a bare-tail fallback; a bare name matches a short name, first match wins
    (the bare-collision case is the deferred follow-up Java records as issue #174).

    This exists so the SUBJECT comparison can be made on object IDENTITY the way
    Java's already is. A bare-name compare cannot tell ``a::NodeBase`` from
    ``b::NodeBase``, which made a genuine cross-package hetero M:N read as a
    self-join the moment the subject set held two names.
    """
    if not name:
        return None
    if PACKAGE_SEP in name:
        return next((o for o in objects if o.resolution_key() == name), None)
    bare = _strip_package(name)
    return next((o for o in objects if o.name == bare), None)


def derive_m2m_fields(
    rel: MetaRelationship,
    source: MetaData,
    object_index: dict[str, MetaData],
) -> M2MFields:
    """Derive the source/target junction FK fields for a M:N relationship.

    *object_index* is a bare-name → object map of the loaded model's top-level
    objects (the Python loader's resolution surface; mirrors the TS
    ``root.findObject``). *source* is the entity the caller is navigating from;
    it is accepted alongside ``rel.parent`` as a name for the relationship's
    subject, and used as the declaring entity when *rel* has no object parent —
    see the module docstring. Raises
    :class:`M2MDerivationError` when the junction is missing/malformed or the
    self-join is ambiguous.
    """
    # The entity that DECLARES ``rel`` — see the module docstring. ``parent`` is
    # the owning entity for both an own declaration and an inherited one (an
    # unmodified inherited child is the SAME node object; an override is a
    # different node whose parent is the overriding entity, also correct).
    rel_parent = rel.parent
    declaring = (
        rel_parent
        if rel_parent is not None and rel_parent.type == TYPE_OBJECT
        else source
    )

    through_name = rel.through()
    if through_name is None:
        raise M2MDerivationError(
            f'relationship "{declaring.name}.{rel.name}" is missing @through '
            f"(required for M:N derivation)"
        )
    junction = object_index.get(_strip_package(through_name))
    if junction is None:
        raise M2MDerivationError(
            f'relationship "{declaring.name}.{rel.name}" @through "{through_name}" '
            f"does not resolve to an entity"
        )

    target_name = rel.object_ref()
    if target_name is None:
        raise M2MDerivationError(
            f'relationship "{declaring.name}.{rel.name}" is missing @objectRef '
            f"(the M:N target)"
        )

    refs = _reference_children(junction)
    if len(refs) != 2:
        raise M2MDerivationError(
            f'junction "{through_name}" for relationship "{declaring.name}.{rel.name}" '
            f"must declare exactly two identity.reference children "
            f"(found {len(refs)})"
        )

    # The relationship's SUBJECT — the entity the M:N hangs off. Under ``extends``
    # there are two legitimate names for it and BOTH occur in real models: the
    # DECLARING entity (what @objectRef names for a self-join declared on an
    # abstract base, and what a junction reference names when the FK points at the
    # base type), and the NAVIGATING entity (*source*, the concrete entity the
    # caller is iterating — usually what a junction FK references, because that is
    # the entity with the physical table). Accepting either is what makes the
    # derivation independent of which entity's effective view reached the
    # relationship. Not covered: a junction reference naming an entity strictly
    # BETWEEN the base and the navigating entity in a deeper hierarchy.
    subject_names = [declaring.name]
    if source.name != declaring.name:
        subject_names.append(source.name)
    subject_label = " or ".join(f'"{n}"' for n in subject_names)

    # Compared by resolved object IDENTITY, matching the Java reference. A
    # package-stripped compare cannot distinguish ``a::NodeBase`` from
    # ``b::NodeBase``, so with two names in the set a genuine cross-package hetero
    # M:N read as a self-join and refused to derive.
    root_objects = _root_objects(declaring)

    def _is_subject(entity: MetaData | None) -> bool:
        return entity is not None and (entity is declaring or entity is source)

    # Defensive bare fallback when @objectRef does not resolve — loader validation
    # normally guarantees it does. Same carve-out the Java reference makes.
    target_entity_node = _find_entity(root_objects, target_name)
    is_self_join = (
        _is_subject(target_entity_node)
        if target_entity_node is not None
        else _strip_package(target_name) in subject_names
    )

    if not is_self_join:
        # Hetero: match each reference by the ENTITY OBJECT it resolves to.
        source_ref = next(
            (
                r
                for r in refs
                if _is_subject(_find_entity(root_objects, _ref_target_qualified(r)))
            ),
            None,
        )
        # Identity here too. The two searches are INDEPENDENT — nothing excludes
        # source_ref from this one, unlike the directed self-join branch below — so a
        # bare compare could match the SOURCE-side reference again whenever the
        # target's short name equals the source's, and silently return (src_fk, src_fk).
        # Java matches identity on both sides (findRefToSubject + findRefToObject).
        target_ref = (
            next(
                (
                    r
                    for r in refs
                    if _find_entity(root_objects, _ref_target_qualified(r))
                    is target_entity_node
                ),
                None,
            )
            if target_entity_node is not None
            else next(
                (r for r in refs if _ref_target_entity(r) == _strip_package(target_name)),
                None,
            )
        )
        source_field = _ref_fk_field(source_ref) if source_ref is not None else None
        target_field = _ref_fk_field(target_ref) if target_ref is not None else None
        if source_field is None or target_field is None:
            raise M2MDerivationError(
                f'junction "{through_name}" for relationship '
                f'"{declaring.name}.{rel.name}" must declare one identity.reference '
                f'to {subject_label} and one to "{_strip_package(target_name)}"'
            )
        return M2MFields(source_field=source_field, target_field=target_field)

    # Self-join: both references resolve to the same entity.
    if rel.symmetric():
        # Undirected: take references in declaration order; union at read time.
        a = _ref_fk_field(refs[0])
        b = _ref_fk_field(refs[1])
        if a is None or b is None:
            raise M2MDerivationError(
                f'symmetric junction "{through_name}" for '
                f'"{declaring.name}.{rel.name}" has a reference with no @fields'
            )
        return M2MFields(source_field=a, target_field=b)

    source_ref_field = rel.source_ref_field()
    if source_ref_field is None:
        raise M2MDerivationError(
            f'self-join relationship "{declaring.name}.{rel.name}" through '
            f'"{through_name}" is ambiguous: set @sourceRefField (directed) or '
            f"@symmetric (undirected)"
        )

    # Directed self-join: @sourceRefField names the source-side FK; the other
    # reference is the target side.
    source_ref = next(
        (r for r in refs if _ref_fk_field(r) == source_ref_field), None
    )
    if source_ref is None:
        raise M2MDerivationError(
            f'@sourceRefField "{source_ref_field}" on "{declaring.name}.{rel.name}" '
            f"does not match any identity.reference FK field on junction "
            f'"{through_name}"'
        )
    target_ref = next((r for r in refs if r is not source_ref), None)
    target_field = _ref_fk_field(target_ref) if target_ref is not None else None
    if target_field is None:
        raise M2MDerivationError(
            f'junction "{through_name}" for "{declaring.name}.{rel.name}" has no '
            f"distinct target-side reference"
        )
    return M2MFields(source_field=source_ref_field, target_field=target_field)
