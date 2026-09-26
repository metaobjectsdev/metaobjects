"""Stages 2-3: isolate and select the payload root span.

JSON: extract picks among json_candidates by the schema (fenced first, first object carrying a
declared field); json() (first-closed-else-first-open) is its fallback.
"""
from __future__ import annotations

import re

from metaobjects.render.extract.json_forgiving_reader import comment_end


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


def json_candidates(text: str | None) -> list[str]:
    """Every top-level object span in ``text``, in order: each balanced {...} (nested objects
    are part of their parent, not separate spans), and, for a '{' that never closes, the text
    from it to the end."""
    out: list[str] = []
    if text is None:
        return out
    tail_added = False
    i = 0
    while i < len(text):
        if text[i] == "{":
            end = _scan_balanced(text, i)
            if end >= 0:
                out.append(text[i : end + 1])
                i = end
            elif not tail_added:
                out.append(text[i:])
                tail_added = True
        i += 1
    return out


def _scan_balanced(s: str, open_idx: int) -> int:
    """Return index of the matching ``}``, or -1 if unterminated. String-aware, and
    comment-aware: a ``//`` / ``/* */`` comment opening after whitespace or a separator is
    skipped, so a brace or quote inside it cannot close the object early (``http://x`` is
    not a comment)."""
    depth = 0
    in_str = False
    esc = False
    i = open_idx - 1
    while i + 1 < len(s):
        i += 1
        c = s[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if i > open_idx and (s[i - 1].isspace() or s[i - 1] in ",{["):
            end = comment_end(s, i)
            if end >= 0:
                i = end - 1
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
