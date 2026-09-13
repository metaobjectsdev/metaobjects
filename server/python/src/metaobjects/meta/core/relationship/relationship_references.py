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
    @objectRef may each be bare or fully qualified.
    """
    target = strip_package(target_entity)
    candidates: list[MetaData] = []
    # ADR-0039: resolving -- children() honors references inherited via extends.
    for child in holder.children():
        if child.type != TYPE_IDENTITY or child.sub_type != IDENTITY_SUBTYPE_REFERENCE:
            continue
        references = child.get_meta_attr(IDENTITY_REFERENCE_ATTR_REFERENCES)
        if not isinstance(references, str) or not references:
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
