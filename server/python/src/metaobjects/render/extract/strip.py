"""Stage 1: remove markdown code-fence markers.

Prose around the payload is left for ``locate`` to handle.
"""
from __future__ import annotations

import re

# Captures the body inside a fenced block; optional language tag (json/xml/etc) is dropped.
_FENCE = re.compile(r"```[a-zA-Z0-9_-]*[ \t]*\r?\n(.*?)\r?\n?```", re.DOTALL)


def strip(raw: str | None) -> str:
    """Strip the first markdown code fence, splicing its body back in place; else trim."""
    if raw is None:
        return ""
    m = _FENCE.search(raw)
    if m:
        return (raw[: m.start()] + m.group(1) + raw[m.end():]).strip()
    return raw.strip()


def fenced_bodies(raw: str | None) -> list[str]:
    """The body of every fenced block, in order. Locate searches these before the whole
    text, because a model told to fence its answer puts the answer there."""
    if raw is None:
        return []
    return [m.group(1) for m in _FENCE.finditer(raw)]
