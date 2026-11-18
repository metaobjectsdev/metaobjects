"""A per-node lookup index over a root's direct children (the top-level nodes).

Reference resolution and overlay merging ask "which top-level node has this key?" once per
reference or declaration. Answering by scanning the child list and building each candidate's
key is O(N) per question and O(N^2) per model; this answers from a dict.

Semantics are those of the scans it replaces: the FIRST match in child order wins.

Never stale. An index is valid for one ``_structure_epoch`` of the root (``meta_data.py``),
which every non-append change to the child list and every change to a package feeding a
resolution key bumps. A pure append is picked up by scanning only the new tail (the first
match still wins, since later children only add keys), so a loop that interleaves adds and
lookups stays linear. Only a parentless node without a super is indexed (a loader root);
anything else takes the original scan.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Callable, NamedTuple, Optional

if TYPE_CHECKING:
    from .meta.meta_data import MetaData


class TopLevelView(NamedTuple):
    """What a lookup indexes: which children count and how a child is keyed."""

    id: str
    includes: Callable[["MetaData"], bool]
    key_of: Callable[["MetaData"], str]


class _Index:
    __slots__ = ("by_key", "scanned", "epoch")

    def __init__(self, epoch: int) -> None:
        self.by_key: dict[str, "MetaData"] = {}
        self.scanned = 0
        self.epoch = epoch


# Observable for tests: how many indexes were (re)built from scratch.
STATS = {"rebuilds": 0}


def find_top_level_by_key(
    root: "MetaData",
    view: TopLevelView,
    key: str,
    linear: Callable[[], Optional["MetaData"]],
) -> Optional["MetaData"]:
    """The first child of *root* that *view* includes whose key is *key*, in child order.

    *linear* is the original scan, used when *root* is not indexable."""
    if root._parent is not None or root.super_data is not None:
        return linear()
    indexes = root._top_level_indexes
    if indexes is None:
        indexes = root._top_level_indexes = {}
    index = indexes.get(view.id)
    children = root._child_list
    count = len(children)
    if index is None or index.epoch != root._structure_epoch or index.scanned > count:
        index = indexes[view.id] = _Index(root._structure_epoch)
        STATS["rebuilds"] += 1
    by_key = index.by_key
    for i in range(index.scanned, count):
        child = children[i]
        if view.includes(child):
            by_key.setdefault(view.key_of(child), child)
    index.scanned = count
    return by_key.get(key)
