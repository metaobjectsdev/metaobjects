"""FR-011: enum-variant normalization for the Coerce stage.

ASCII-only by design: enum members are ASCII identifiers, so a pure ``[A-Za-z0-9]``
transform is byte-identical across ports and sidesteps locale case-folding
(Turkish-I). The mode comes from the ``@normalize`` attr (``none|collapse|strip``;
default ``strip``). Mirrors the TS ``normalizeEnum``, the C# ``Normalize.Enum``, and
the Java ``Normalize.enumValue``.

**Uppercasing is a MANUAL a-z -> A-Z fold**, NOT :py:meth:`str.upper` (which is
Unicode-aware and would diverge on non-ASCII). Only the 26 ASCII lowercase letters
are folded; every other code point passes through unchanged.
"""
from __future__ import annotations

from typing import Final

# FR-011 @normalize modes — the closed cross-port vocabulary.
NONE: Final = "none"  # exact match only (no normalization)
COLLAPSE: Final = "collapse"  # ASCII-upper + trim + collapse runs of [\s_-]+ to "_"
STRIP: Final = "strip"  # ASCII-upper + keep only [A-Z0-9]
DEFAULT: Final = STRIP  # default when absent on both field and owning object

# The separator set for COLLAPSE: the JS `\s` whitespace class PLUS `_` and `-`.
# The corpus only exercises ASCII space, but the full set keeps byte-identical
# cross-port parity with the Java/C#/TS ports' isSeparator.
_SEPARATORS: Final = frozenset(
    {
        "_",
        "-",
        " ",  # space
        "\t",  # tab
        "\n",  # line feed
        "\v",  # vertical tab (U+000B)
        "\f",  # form feed
        "\r",  # carriage return
        " ",  # no-break space
        " ",  # ogham space mark
        " ",  # line separator
        " ",  # paragraph separator
        " ",  # narrow no-break space
        " ",  # medium mathematical space
        "　",  # ideographic space
        "﻿",  # zero-width no-break space (BOM)
    }
    # U+2000..U+200A (en/em/thin spaces etc.) — the rest of the JS \s range.
    | {chr(c) for c in range(0x2000, 0x200B)}
)


def normalize_enum(s: str, mode: str) -> str:
    """ASCII-only enum normalization. Pure ``[A-Za-z0-9]`` transform → byte-identical cross-port.

    * ``none`` — identity.
    * ``collapse`` — ASCII-upper + trim + collapse runs of ``[\\s_-]+`` to a single ``_``.
    * ``strip`` — ASCII-upper + keep only ``[A-Z0-9]``.

    Any unknown mode is treated as ``strip`` (the default), matching the cross-port resolver.
    """
    if mode == NONE:
        return s
    up = _ascii_upper(s.strip())
    return _collapse_separators(up) if mode == COLLAPSE else _strip_non_alnum(up)


def _ascii_upper(s: str) -> str:
    """ASCII-only uppercasing (a-z -> A-Z); all other code points pass through unchanged."""
    out: list[str] = []
    for ch in s:
        c = ord(ch)
        out.append(chr(c - 32) if 0x61 <= c <= 0x7A else ch)
    return "".join(out)


def _collapse_separators(s: str) -> str:
    """Collapse runs of whitespace / underscore / hyphen into a single ``_`` (mirrors ``/[\\s_-]+/g -> "_"``)."""
    out: list[str] = []
    in_run = False
    for ch in s:
        if ch in _SEPARATORS:
            if not in_run:
                out.append("_")
                in_run = True
        else:
            out.append(ch)
            in_run = False
    return "".join(out)


def _strip_non_alnum(s: str) -> str:
    """Keep only ``[A-Z0-9]`` (mirrors ``/[^A-Z0-9]/g -> ""`` on an already-uppercased string)."""
    out: list[str] = []
    for ch in s:
        c = ord(ch)
        if (0x41 <= c <= 0x5A) or (0x30 <= c <= 0x39):
            out.append(ch)
    return "".join(out)
