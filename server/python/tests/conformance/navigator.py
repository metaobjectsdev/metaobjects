"""Navigate a loaded metadata tree by a list of '<type>:<name>' path segments."""
from __future__ import annotations

from metaobjects.meta.meta_data import MetaData


def navigate(root: MetaData, path_segments: list[str]) -> MetaData | None:
    """Walk the tree from *root* following each '<type>:<name>' segment.

    Each segment is matched against direct children where
    ``child.type == type and child.name == name``.  Returns the resolved node
    or ``None`` if any segment cannot be matched.
    """
    current: MetaData = root
    for segment in path_segments:
        if ":" not in segment:
            return None
        type_part, name_part = segment.split(":", 1)
        matched = next(
            (c for c in current.own_children() if c.type == type_part and c.name == name_part),
            None,
        )
        if matched is None:
            return None
        current = matched
    return current
