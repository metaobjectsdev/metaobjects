"""Stage 1: remove markdown code-fence markers.

Prose around the payload is left for ``locate`` to handle.
"""
from __future__ import annotations

import re
from typing import NamedTuple

# An opening fence: a run of 3+ backticks, an optional language tag (json/xml/etc, dropped), a line end.
_OPEN = re.compile(r"(`{3,})[a-zA-Z0-9_-]*\s*\r?\n")


class _Fence(NamedTuple):
    start: int  # index of the opening backticks
    end: int  # index just past the closing backticks
    body: str


def _fences(raw: str) -> list[_Fence]:
    """Every fenced block, in order. A fence closes at a line that starts with a backtick run at
    least as long as the opening one and carries nothing else, so backticks inside the payload (a
    JSON string holding ``make`` or a nested code sample) do not truncate it. A reply that closes
    on the payload's own line is accepted when that run ends the text."""
    out: list[_Fence] = []
    pos = 0
    while True:
        m = _OPEN.search(raw, pos)
        if m is None:
            return out
        close = _find_close(raw, m.end(), len(m.group(1)))
        if close is None:
            pos = m.end()
            continue
        body_end, end = close
        out.append(_Fence(m.start(), end, raw[m.end() : body_end]))
        pos = end


def _find_close(raw: str, start: int, width: int) -> tuple[int, int] | None:
    ls = start
    while ls <= len(raw):
        i = ls
        while i < len(raw) and raw[i] in " \t" and i - ls < 4:
            i += 1
        j = i
        while j < len(raw) and raw[j] == "`":
            j += 1
        if j - i >= width:
            k = j
            while k < len(raw) and raw[k] in " \t":
                k += 1
            if k >= len(raw) or raw[k] in "\r\n":
                return _body_end(raw, start, ls), j
        nl = raw.find("\n", ls)
        if nl < 0:
            break
        ls = nl + 1
    # No closing line: accept a final backtick run that ends the text on the payload's own line.
    tail = raw.rstrip()
    k = len(tail)
    while k > start and tail[k - 1] == "`":
        k -= 1
    if len(tail) - k >= width and k > start:
        return k, len(tail)
    return None


def _body_end(raw: str, start: int, line_start: int) -> int:
    e = line_start
    if e > start and raw[e - 1] == "\n":
        e -= 1
    if e > start and raw[e - 1] == "\r":
        e -= 1
    return e


def strip(raw: str | None) -> str:
    """Strip the first markdown code fence, splicing its body back in place; else trim."""
    if raw is None:
        return ""
    fences = _fences(raw)
    if fences:
        f = fences[0]
        return (raw[: f.start] + f.body + raw[f.end :]).strip()
    return raw.strip()


def fenced_bodies(raw: str | None) -> list[str]:
    """The body of every fenced block, in order. Locate searches these before the whole
    text, because a model told to fence its answer puts the answer there."""
    if raw is None:
        return []
    return [f.body for f in _fences(raw)]
