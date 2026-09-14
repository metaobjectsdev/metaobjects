"""Association -> identity.reference resolution (issue #368).

An entity may declare more than one identity.reference onto the SAME target
entity (Match.homeTeamRef and Match.awayTeamRef both -> Team). A
``@cardinality: one`` relationship names only its target, so when two
references match, the target alone cannot say which FK the navigation uses.
Taking the first match emits a join on the wrong column that typechecks, has
correct DDL and passes verify -- so the ladder below resolves it explicitly or
not at all. ADR-0029 Section 5: ambiguity is a load error naming the
candidates.

Python port of the TypeScript reference implementation
(``metadata/src/core/relationship/resolve-relationship-reference.ts``) --
that file is the authoritative spec; this module mirrors it exactly (same
suffix list, same order, same "candidate side only" stripping).
"""
from __future__ import annotations

from ...meta_data import MetaData
from ....naming import strip_package
from ....shared.base_types import TYPE_IDENTITY
from ....shared.separators import PACKAGE_SEP
from ..identity.identity_constants import (
    IDENTITY_ATTR_FIELDS,
    IDENTITY_REFERENCE_ATTR_REFERENCES,
    IDENTITY_SUBTYPE_REFERENCE,
)

# Trailing suffixes stripped from a CANDIDATE's name/FK field when building its
# pairing keys. Ordered -- first match wins, so "reference" is tested before
# "ref". Never applied to the relationship name (see reference_pairing_keys).
PAIRING_SUFFIXES: tuple[str, ...] = ("reference", "ref", "id", "key")


def _strip_one_suffix(value: str) -> str:
    for suffix in PAIRING_SUFFIXES:
        if len(value) > len(suffix) and value.endswith(suffix):
            return value[: len(value) - len(suffix)]
    return value


def reference_fields(ref: MetaData) -> list[str]:
    """The full @fields tuple of an identity.reference, in declared order.

    @fields may be authored as a JSON array (the normal identity.reference
    shape) or as a single bare string (as identity.primary sometimes is) --
    both are normalized here so callers never branch on authoring shape.
    """
    fields = ref.get_meta_attr(IDENTITY_ATTR_FIELDS)  # ADR-0039: resolving.
    if isinstance(fields, (list, tuple)):
        return [f for f in fields if isinstance(f, str)]
    if isinstance(fields, str) and fields:
        return [f.strip() for f in fields.split(",") if f.strip()]
    return []


def reference_target_entity(ref: MetaData) -> str | None:
    """The TARGET-ENTITY half of an ``identity.reference``'s ``@references``.

    ``@references`` is either a bare entity name (``Team`` / ``acme::sport::Team``,
    meaning "the target's primary identity") or the dotted ``Entity.field`` /
    ``Entity.fieldA,fieldB`` form (``Team.id``) naming explicit target fields.
    Both forms name the same entity, so the entity half is the segment BEFORE the
    first ``.`` — mirroring the other three ports' ``targetEntity`` accessor
    (TS ``MetaReferenceIdentity.targetEntity``, C# ``MetaReferenceIdentity.TargetEntity``,
    Java ``ReferenceIdentity.getTargetEntity()``), which is the authoritative shape.
    Python has no MetaReferenceIdentity subclass to hang it on, so it lives here.

    The dot is searched only AFTER the last package separator so a ``::``-qualified
    name can never have a package segment mistaken for the field separator. Returns
    None when the attr is absent or empty.

    Reused (not reimplemented) by ``codegen.generators.router_generator.reverse_fks_for``
    and ``derive_m2m_fields._ref_target_entity`` — both had their own copy of this exact
    blind spot before #368's follow-up fixed them onto this one. ``naming_refs.
    _split_child_tail`` runs the same character-level search but stays a separate,
    private implementation (desugar-phase, over raw pre-resolution strings, five
    attribute kinds, keeps the tail) — see its docstring for why it isn't merged here.
    """
    raw = ref.get_meta_attr(IDENTITY_REFERENCE_ATTR_REFERENCES)  # ADR-0039: resolving.
    if not isinstance(raw, str) or not raw:
        return None
    sep = raw.rfind(PACKAGE_SEP)
    start = sep + len(PACKAGE_SEP) if sep >= 0 else 0
    dot = raw.find(".", start)
    return raw if dot == -1 else raw[:dot]


def _first_fk_field(ref: MetaData) -> str | None:
    """The FK field a reference is anchored on (first field; composite FKs
    pair on their first column)."""
    fields = reference_fields(ref)
    return fields[0] if fields else None


def reference_pairing_keys(ref: MetaData) -> set[str]:
    """The set of lowercased names a candidate reference answers to: its own
    name and its FK field, each with and without one stripped suffix."""
    keys: set[str] = set()

    def _add(value: str | None) -> None:
        if not value:
            return
        lower = value.lower()
        keys.add(lower)
        keys.add(_strip_one_suffix(lower))

    _add(ref.name)
    _add(_first_fk_field(ref))
    return keys


def reference_candidates_for(holder: MetaData, target_entity: str) -> list[MetaData]:
    """Every identity.reference on ``holder`` whose @references targets
    ``target_entity``. Package-insensitive on both sides: @references and
    @objectRef may each be bare or fully qualified, and @references may use the
    dotted ``Entity.field`` form (see :func:`reference_target_entity`).
    """
    target = strip_package(target_entity)
    candidates: list[MetaData] = []
    # ADR-0039: resolving -- children() honors references inherited via extends.
    for child in holder.children():
        if child.type != TYPE_IDENTITY or child.sub_type != IDENTITY_SUBTYPE_REFERENCE:
            continue
        references = reference_target_entity(child)
        if references is None:
            continue
        if strip_package(references) != target:
            continue
        if _first_fk_field(child) is None:
            continue
        candidates.append(child)
    return candidates


def resolve_relationship_reference(
    holder: MetaData,
    relationship_name: str,
    target_entity: str,
    source_ref_field: str | None = None,
) -> MetaData | None:
    """Which identity.reference does this ``@cardinality: one`` relationship
    navigate through? The ladder, in order:

      1. exactly one candidate            -> that one (the common case; unchanged behaviour)
      2. ``@sourceRefField`` declared     -> the candidate whose FK field it names
      3. exactly one candidate name-pairs -> that one
      4. otherwise                        -> None (caller reports the ambiguity)

    Returns None for "no candidate" and "cannot choose" alike; callers that
    need to tell them apart use :func:`reference_candidates_for`.
    """
    candidates = reference_candidates_for(holder, target_entity)
    if len(candidates) == 0:
        return None
    if len(candidates) == 1:
        return candidates[0]

    if source_ref_field is not None and source_ref_field != "":
        return next(
            (c for c in candidates if _first_fk_field(c) == source_ref_field), None
        )

    wanted = relationship_name.lower()
    paired = [c for c in candidates if wanted in reference_pairing_keys(c)]
    return paired[0] if len(paired) == 1 else None
