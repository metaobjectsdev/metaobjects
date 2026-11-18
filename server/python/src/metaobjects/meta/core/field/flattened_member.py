"""A member of a ``@storage: flattened`` value object, addressed through the field that embeds it
(``address.city``): one level, the embedding field on the entity, the member on its
``@objectRef`` value object. Its column lives on the entity's table, so a passthrough ``@from`` or
an ``@of`` may name it. Mirrors the TypeScript ``resolveFlattenedMember``.
"""
from __future__ import annotations

from typing import NamedTuple

from metaobjects.meta.core.field.field_constants import (
    FIELD_ATTR_OBJECT_REF,
    FIELD_ATTR_STORAGE,
    FIELD_SUBTYPE_OBJECT,
    STORAGE_FLATTENED,
)
from metaobjects.meta.meta_data import MetaData
from metaobjects.naming_refs import ref_target
from metaobjects.shared.base_types import TYPE_FIELD


class FlattenedMember(NamedTuple):
    embedding: MetaData
    member: MetaData


def resolve_flattened_member(entity: MetaData, path: str) -> FlattenedMember | None:
    """The ``<embedding>.<member>`` *path* on *entity*, or ``None`` when it names no member of a
    flattened value object."""
    head, dot, tail = path.partition(".")
    if not dot or not head or not tail or "." in tail:
        return None
    # Effective children: the embedding field may be inherited via extends.
    embedding = next((c for c in entity.children() if c.type == TYPE_FIELD and c.name == head), None)
    if embedding is None or embedding.sub_type != FIELD_SUBTYPE_OBJECT:
        return None
    # ADR-0039: resolving — @storage / @objectRef may be inherited via extends.
    if embedding.get_meta_attr(FIELD_ATTR_STORAGE) != STORAGE_FLATTENED:
        return None
    vo = ref_target(embedding, FIELD_ATTR_OBJECT_REF)
    if vo is None:
        return None
    member = next((c for c in vo.children() if c.type == TYPE_FIELD and c.name == tail), None)
    return None if member is None else FlattenedMember(embedding, member)
