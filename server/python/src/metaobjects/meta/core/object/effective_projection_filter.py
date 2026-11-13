"""A projection's EFFECTIVE ``@filter``: the ``@filter`` declared at every level of its extends
chain, supers first, ANDed flat. An extender cannot drop a gate its super declares, so the view
applies all of them. Mirrors the TypeScript ``effectiveProjectionFilter``.
"""
from __future__ import annotations

from metaobjects.meta.core.object.object_constants import OBJECT_PROJECTION_ATTR_FILTER
from metaobjects.meta.meta_data import MetaData

_AND = "and"


def _and_members(filter_value: object) -> list[object]:
    if isinstance(filter_value, dict) and len(filter_value) == 1 and isinstance(filter_value.get(_AND), list):
        return list(filter_value[_AND])
    return [filter_value]


def effective_projection_filter(projection: MetaData) -> object | None:
    """The ANDed ``@filter`` of *projection* and its supers; ``None`` when no level declares one."""
    levels: list[object] = []
    seen: set[int] = set()
    node: MetaData | None = projection
    while node is not None and id(node) not in seen:
        seen.add(id(node))
        # ADR-0039: own — each level contributes the @filter declared on it; the resolving read
        # would return only the nearest one, which is the override this composition replaces.
        own = node.own_attrs().get(OBJECT_PROJECTION_ATTR_FILTER)
        if own is not None:
            levels.insert(0, own)
        node = node.super_data
    if len(levels) <= 1:
        return levels[0] if levels else None
    return {_AND: [m for level in levels for m in _and_members(level)]}
