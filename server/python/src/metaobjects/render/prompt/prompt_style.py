"""FR-010 artifact 1 — how the output-format fragment teaches the model.

Guidance is NEVER carried in comments (models ignore them) — it lives in prose /
inline placeholders / a filled skeleton. Default is ``"guide"``.

Tier-2 idiomatic Python: the Java SCREAMING_SNAKE enum (GUIDE/INLINE/EXAMPLE_ONLY)
becomes a string enum whose VALUES are the wire ``@promptStyle`` values
(``"guide"`` / ``"inline"`` / ``"exampleOnly"``) — no name<->wire mapping table.
"""
from __future__ import annotations

from enum import Enum


class PromptStyle(Enum):
    """Presentation style of the rendered output-format fragment.

    - ``GUIDE``: prose field list ("Fill in each field…") followed by an example skeleton.
    - ``INLINE``: a single skeleton whose field values are inline placeholders / enum choices.
    - ``EXAMPLE_ONLY``: just a filled example skeleton, nothing else.
    """

    GUIDE = "guide"
    INLINE = "inline"
    EXAMPLE_ONLY = "exampleOnly"


def prompt_style_from(s: str | None) -> PromptStyle:
    """Map the ``@promptStyle`` attribute string to a :class:`PromptStyle`.

    ``None`` or any unrecognized value falls back to ``GUIDE`` (matches Java
    ``PromptStyle.from``).
    """
    if s == PromptStyle.INLINE.value:
        return PromptStyle.INLINE
    if s == PromptStyle.EXAMPLE_ONLY.value:
        return PromptStyle.EXAMPLE_ONLY
    return PromptStyle.GUIDE
