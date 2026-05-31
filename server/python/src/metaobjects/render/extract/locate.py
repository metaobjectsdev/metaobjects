"""Stages 2-3: isolate and select the payload root span.

Selection rule: first-closed-else-first-open.
"""
from __future__ import annotations

import re


def json(text: str | None) -> str | None:
    """First balanced ``{...}``; if none closes, first ``{`` to end; ``None`` if no ``{``."""
    if text is None:
        return None
    first_open = -1
    for i, ch in enumerate(text):
        if ch == "{":
            if first_open < 0:
                first_open = i
            end = _scan_balanced(text, i)
            if end >= 0:
                return text[i : end + 1]
    return None if first_open < 0 else text[first_open:]


def _scan_balanced(s: str, open_idx: int) -> int:
    """Return index of the matching ``}``, or -1 if unterminated. String-aware."""
    depth = 0
    in_str = False
    esc = False
    for i in range(open_idx, len(s)):
        c = s[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i
    return -1


def xml(text: str | None, root_name: str | None, case_insensitive: bool) -> str | None:
    """Span of ``<root>...</root>``; if close absent, opener to end; ``None`` if no opener."""
    if text is None or root_name is None:
        return None
    flags = re.IGNORECASE if case_insensitive else 0
    open_re = re.compile("<" + re.escape(root_name) + r"(\s[^>]*)?>", flags)
    open_m = open_re.search(text)
    if open_m is None:
        return None
    start = open_m.start()
    close_re = re.compile("</" + re.escape(root_name) + r"\s*>", flags)
    close_m = close_re.search(text, open_m.end())
    if close_m is not None:
        return text[start : close_m.end()]
    return text[start:]
