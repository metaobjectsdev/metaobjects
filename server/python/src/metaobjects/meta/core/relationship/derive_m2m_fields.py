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
"""
from __future__ import annotations

from dataclasses import dataclass

from ...meta_data import MetaData
from ....shared.base_types import TYPE_IDENTITY
from ....shared.separators import PACKAGE_SEP
from ..identity.identity_constants import (
    IDENTITY_ATTR_FIELDS,
    IDENTITY_REFERENCE_ATTR_REFERENCES,
    IDENTITY_SUBTYPE_REFERENCE,
)
from .meta_relationship import MetaRelationship


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
    """The @references target-entity name of a reference (bare, package-stripped)."""
    v = ref.get_meta_attr(IDENTITY_REFERENCE_ATTR_REFERENCES)  # ADR-0039: resolving (identity attr)
    return _strip_package(v) if isinstance(v, str) and v else None


def derive_m2m_fields(
    rel: MetaRelationship,
    source: MetaData,
    object_index: dict[str, MetaData],
) -> M2MFields:
    """Derive the source/target junction FK fields for a M:N relationship.

    *object_index* is a bare-name → object map of the loaded model's top-level
    objects (the Python loader's resolution surface; mirrors the TS
    ``root.findObject``). Raises :class:`M2MDerivationError` when the junction is
    missing/malformed or the self-join is ambiguous.
    """
    through_name = rel.through()
    if through_name is None:
        raise M2MDerivationError(
            f'relationship "{source.name}.{rel.name}" is missing @through '
            f"(required for M:N derivation)"
        )
    junction = object_index.get(_strip_package(through_name))
    if junction is None:
        raise M2MDerivationError(
            f'relationship "{source.name}.{rel.name}" @through "{through_name}" '
            f"does not resolve to an entity"
        )

    target_name = rel.object_ref()
    if target_name is None:
        raise M2MDerivationError(
            f'relationship "{source.name}.{rel.name}" is missing @objectRef '
            f"(the M:N target)"
        )

    refs = _reference_children(junction)
    if len(refs) != 2:
        raise M2MDerivationError(
            f'junction "{through_name}" for relationship "{source.name}.{rel.name}" '
            f"must declare exactly two identity.reference children "
            f"(found {len(refs)})"
        )

    is_self_join = _strip_package(target_name) == source.name

    if not is_self_join:
        # Hetero: match each reference by the entity it resolves to.
        source_ref = next(
            (r for r in refs if _ref_target_entity(r) == source.name), None
        )
        target_ref = next(
            (r for r in refs if _ref_target_entity(r) == _strip_package(target_name)),
            None,
        )
        source_field = _ref_fk_field(source_ref) if source_ref is not None else None
        target_field = _ref_fk_field(target_ref) if target_ref is not None else None
        if source_field is None or target_field is None:
            raise M2MDerivationError(
                f'junction "{through_name}" for relationship '
                f'"{source.name}.{rel.name}" must declare one identity.reference '
                f'to "{source.name}" and one to "{_strip_package(target_name)}"'
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
                f'"{source.name}.{rel.name}" has a reference with no @fields'
            )
        return M2MFields(source_field=a, target_field=b)

    source_ref_field = rel.source_ref_field()
    if source_ref_field is None:
        raise M2MDerivationError(
            f'self-join relationship "{source.name}.{rel.name}" through '
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
            f'@sourceRefField "{source_ref_field}" on "{source.name}.{rel.name}" '
            f"does not match any identity.reference FK field on junction "
            f'"{through_name}"'
        )
    target_ref = next((r for r in refs if r is not source_ref), None)
    target_field = _ref_fk_field(target_ref) if target_ref is not None else None
    if target_field is None:
        raise M2MDerivationError(
            f'junction "{through_name}" for "{source.name}.{rel.name}" has no '
            f"distinct target-side reference"
        )
    return M2MFields(source_field=source_ref_field, target_field=target_field)
