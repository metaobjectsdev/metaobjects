"""A projection ``@filter`` key that is a PATH from the base entity (``caseId.status``): to-one
hops (an identity.reference, or a ``@cardinality: one`` relationship), then a field of the entity
reached. The view joins what it walks; a to-many hop would multiply rows, so it is refused.
Mirrors the TypeScript ``resolveFilterPath``.
"""
from __future__ import annotations

from typing import NamedTuple, Union

from metaobjects.meta.core.identity.identity_constants import (
    IDENTITY_REFERENCE_ATTR_REFERENCES,
    IDENTITY_SUBTYPE_REFERENCE,
)
from metaobjects.meta.core.relationship.relationship_constants import (
    CARDINALITY_ONE,
    RELATIONSHIP_ATTR_CARDINALITY,
    RELATIONSHIP_ATTR_OBJECT_REF,
)
from metaobjects.meta.meta_data import MetaData
from metaobjects.naming_refs import ref_target
from metaobjects.shared.base_types import TYPE_FIELD, TYPE_IDENTITY, TYPE_OBJECT, TYPE_RELATIONSHIP


class FilterPath(NamedTuple):
    hops: list[str]
    entity: MetaData
    field: MetaData


def _to_one_hop(obj: MetaData, hop: str) -> Union[MetaData, str]:
    # ADR-0039: resolving — a hop may be inherited through extends.
    ref = next(
        (c for c in obj.children()
         if c.type == TYPE_IDENTITY and c.sub_type == IDENTITY_SUBTYPE_REFERENCE and c.name == hop),
        None,
    )
    if ref is not None:
        target = ref_target(ref, IDENTITY_REFERENCE_ATTR_REFERENCES)
        return target if target is not None and target.type == TYPE_OBJECT else (
            f'reference "{obj.name}.{hop}" does not resolve'
        )
    rel = next((c for c in obj.children() if c.type == TYPE_RELATIONSHIP and c.name == hop), None)
    if rel is not None:
        # ADR-0039: resolving — @cardinality may be inherited.
        if rel.get_meta_attr(RELATIONSHIP_ATTR_CARDINALITY) != CARDINALITY_ONE:
            return f'"{obj.name}.{hop}" is to-many; a filter path may only walk to-one hops'
        target = ref_target(rel, RELATIONSHIP_ATTR_OBJECT_REF)
        return target if target is not None and target.type == TYPE_OBJECT else (
            f'relationship "{obj.name}.{hop}" does not resolve'
        )
    return f'"{obj.name}" declares no identity.reference or to-one relationship named "{hop}"'


def resolve_filter_path(base: MetaData, key: str) -> Union[FilterPath, str, None]:
    """The path *key* names from *base*; a message when it does not resolve; ``None`` when *key*
    is not a path at all (no dot)."""
    segments = key.split(".")
    if len(segments) < 2:
        return None
    hops, field_name = segments[:-1], segments[-1]
    current = base
    for hop in hops:
        nxt = _to_one_hop(current, hop)
        if isinstance(nxt, str):
            return nxt
        current = nxt
    # ADR-0039: resolving — the reached field may be inherited.
    field = next((c for c in current.children() if c.type == TYPE_FIELD and c.name == field_name), None)
    if field is None:
        return f'"{current.name}" declares no field "{field_name}"'
    return FilterPath(hops, current, field)
