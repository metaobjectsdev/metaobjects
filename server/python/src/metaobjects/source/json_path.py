"""FR5a / ADR-0009 — Canonical JSONPath builder.

Construction rules (cross-port-aligned; every port emits this canonical form
byte-identically):
    * Root is ``$``.
    * Object keys matching ``^[A-Za-z_][A-Za-z0-9_]*$`` use dot notation: ``.foo``.
    * All other keys use single-quoted bracket form: ``['my-key']``,
      ``['@attr']``. Embedded single quotes are escaped with ``\\'``.
    * Array indices use bracket form: ``[N]`` (zero-based).
    * No trailing dots, no whitespace.

Mirrors:
    * TS  — `server/typescript/packages/metadata/src/json-path.ts`
    * C#  — `server/csharp/MetaObjects/Source/JsonPath.cs`
"""
from __future__ import annotations

import re
from typing import Optional, Union

# Identifier regex shared with the static :class:`JsonPath` helpers. Compiled
# once at module load.
_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _render_key_segment(key: str) -> str:
    """Render a single object-key segment: dot notation if identifier-safe, else bracket form."""
    if _IDENT_RE.match(key):
        return f".{key}"
    escaped = key.replace("'", "\\'")
    return f"['{escaped}']"


def _render_index_segment(idx: int) -> str:
    """Render a single array-index segment: ``[N]``."""
    return f"[{idx}]"


class JsonPathBuilder:
    """Builds the canonical JSONPath string for a node as the parser walks the
    JSON tree. Push a key or index when descending; pop when returning.

    Mirrors ``JsonPathBuilder`` in
    ``typescript/packages/metadata/src/json-path.ts`` and the C# implementation.
    """

    __slots__ = ("_segments",)

    def __init__(self) -> None:
        # Each segment is (kind, payload): kind is "key" or "index".
        self._segments: list[tuple[str, Union[str, int]]] = []

    def push_key(self, key: str) -> None:
        """Push an object key segment (e.g. ``.foo`` or ``['my-key']``)."""
        self._segments.append(("key", key))

    def push_index(self, idx: int) -> None:
        """Push an array-index segment (e.g. ``[2]``)."""
        self._segments.append(("index", idx))

    def pop(self) -> None:
        """Pop the most recently pushed segment."""
        if self._segments:
            self._segments.pop()

    @property
    def depth(self) -> int:
        """Number of segments currently on the stack (root is segment 0; not counted)."""
        return len(self._segments)

    def to_string(self) -> str:
        """Render the current stack as a canonical JSONPath string."""
        parts: list[str] = ["$"]
        for kind, payload in self._segments:
            if kind == "index":
                # mypy-friendly: cast not needed; assignment ensures int.
                parts.append(_render_index_segment(int(payload)))
            else:
                parts.append(_render_key_segment(str(payload)))
        return "".join(parts)

    def __str__(self) -> str:  # pragma: no cover — convenience
        return self.to_string()


class JsonPath:
    """Static helpers for one-shot JSONPath rendering when a builder is overkill.

    Equivalent to the C# ``JsonPath`` static helpers; namespaced as a class so
    the call sites read identically in Python (``JsonPath.segment_for_key(...)``).
    """

    @staticmethod
    def segment_for_key(key: str) -> str:
        """Render a single object-key segment as it would appear in canonical
        form, without the leading ``$`` — i.e. ``.foo`` or ``['my-key']``.
        """
        return _render_key_segment(key)

    @staticmethod
    def segment_for_index(idx: int) -> str:
        """Render a single array-index segment: ``[N]``."""
        return _render_index_segment(idx)


__all__ = ["JsonPath", "JsonPathBuilder"]
