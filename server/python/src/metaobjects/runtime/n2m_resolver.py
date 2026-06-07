"""Generic, metadata-driven M:N (many-to-many) query resolver.

A M:N relationship declares only the slim FR-018 vocabulary on the source
entity: ``@cardinality: "many"`` + ``@objectRef: <target>`` + ``@through:
<junction>`` (plus optional ``@sourceRefField`` / ``@symmetric`` for self-joins).
It does NOT restate the junction FK columns — those are DERIVED from the junction
entity's two ``identity.reference`` children via the shared ``derive_m2m_fields``
helper (the SSOT for FK direction, the same one the loader validator + every
other port use).

Resolution has three modes (mirrors the TS reference ``n2m-resolver.ts``):

  1. Hetero (source != target): junction WHERE sourceField (=|IN) source.pk,
     collect targetField, then target WHERE pk IN (...).
  2. Directed self-join (``@sourceRefField``): identical traversal; the helper
     has already picked which junction FK is the source side.
  3. Symmetric self-join (``@symmetric: true``): single-row storage, union on
     read — junction WHERE sourceField (=|IN) id OR targetField (=|IN) id; for
     each row the related id is whichever FK column is NOT the source id (a
     self-loop row where both columns are the source yields the source itself).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ..meta.core.object.meta_object import MetaObject
from ..meta.core.relationship.derive_m2m_fields import (
    M2MDerivationError,
    derive_m2m_fields,
)
from ..meta.core.relationship.meta_relationship import MetaRelationship
from ..meta.core.relationship.relationship_constants import CARDINALITY_MANY

if TYPE_CHECKING:  # pragma: no cover
    from ..meta.meta_root import MetaRoot


@dataclass(frozen=True)
class N2mDescriptor:
    """The resolved coordinates of a M:N traversal.

    ``source_field`` / ``target_field`` are the *metadata field names* on the
    junction (the runtime maps them to physical columns); ``symmetric`` selects
    the union-on-read read path.
    """

    source_entity_name: str
    target_entity_name: str
    junction_entity_name: str
    source_field: str
    target_field: str
    symmetric: bool


class N2mResolutionError(Exception):
    """Raised when a named M:N relationship cannot be resolved."""

    code = "ERR_INVALID_RELATIONSHIP"


def resolve_n2m_descriptor(
    source_entity: MetaObject,
    relation_name: str,
    object_index: dict[str, MetaObject],
) -> N2mDescriptor | None:
    """Resolve a M:N relationship on *source_entity* by name.

    Returns ``None`` when the named relationship is not M:N (no ``@through``) —
    the caller should fall through to its 1:1 / 1:N relation path. Raises
    :class:`N2mResolutionError` when the relationship IS M:N but malformed.

    *object_index* is a bare-name → object map of the loaded model's top-level
    objects (mirrors the TS ``root.findObject`` resolution surface).
    """
    for child in source_entity.own_children():
        if not isinstance(child, MetaRelationship):
            continue
        if child.name != relation_name:
            continue
        if child.cardinality() != CARDINALITY_MANY:
            continue
        if child.through() is None:
            # Cardinality-many but no junction → 1:N, not M:N.
            return None

        target_name = child.object_ref()
        junction_name = child.through()
        if not target_name or not junction_name:
            raise N2mResolutionError(
                f"M:N relationship '{relation_name}' on '{source_entity.name}' "
                f"requires @objectRef + @through"
            )

        try:
            fields = derive_m2m_fields(child, source_entity, object_index)
        except M2MDerivationError as e:
            raise N2mResolutionError(
                f"M:N relationship '{relation_name}' on '{source_entity.name}': {e}"
            ) from e

        return N2mDescriptor(
            source_entity_name=source_entity.name,
            target_entity_name=_strip_package(target_name),
            junction_entity_name=_strip_package(junction_name),
            source_field=fields.source_field,
            target_field=fields.target_field,
            symmetric=child.symmetric(),
        )
    return None


def collect_symmetric_target_ids(
    join_rows: list[dict[str, Any]],
    source_col: str,
    target_col: str,
    source_ids: set[Any],
) -> list[Any]:
    """Symmetric union-on-read: for each junction row, the related id is whichever
    of (source_col, target_col) is NOT a source id. A self-loop row (both columns
    the source id) yields the source id itself.

    Membership is compared by string-coerced key: the source ids come from the
    in-process source record while the junction FK values come straight off the
    driver, where a BIGINT key may arrive as a differing native type. Comparing
    by ``str()`` bridges any number-vs-string mismatch — exactly the TS reference
    behaviour.
    """
    source_keys = {str(v) for v in source_ids}
    seen: dict[str, Any] = {}
    for row in join_rows:
        a = row.get(source_col)
        b = row.get(target_col)
        a_is_source = a is not None and str(a) in source_keys
        other = b if a_is_source else a
        if other is None:
            continue
        seen.setdefault(str(other), other)
    return list(seen.values())


def collect_column_ids(join_rows: list[dict[str, Any]], col: str) -> list[Any]:
    """Distinct non-null values of one junction column (declaration order)."""
    seen: dict[str, Any] = {}
    for row in join_rows:
        v = row.get(col)
        if v is None:
            continue
        seen.setdefault(str(v), v)
    return list(seen.values())


def _strip_package(name: str) -> str:
    idx = name.rfind("::")
    return name[idx + 2:] if idx >= 0 else name
