"""Stage-4 tolerant XML reader for the bounded corpus malformation set. Never throws.

Carries the FR-010 fixed-behavior edge cases:

- No-throw on a leading ``</x>``.
- Unclosed tags extract their text up to the next sibling open tag.
"""
from __future__ import annotations

import re

_OPEN_TAG = re.compile(r"<([A-Za-z_][A-Za-z0-9_]*)(\s[^>]*)?>")
_OPEN_TAG_CI = re.compile(r"<([A-Za-z_][A-Za-z0-9_]*)(\s[^>]*)?>", re.IGNORECASE)


class XmlForgivingReader:
    def read(self, span: str | None, case_insensitive: bool) -> dict[str, object]:
        out: dict[str, object] = {}
        if span is None or span.strip() == "":
            return out
        gt = span.find(">")
        if gt < 0:
            return out
        root_end = span.rfind("</")
        inner_end = len(span) if (root_end < 0 or root_end <= gt) else root_end
        inner = span[gt + 1 : inner_end]
        self._parse_children(inner, case_insensitive, out)
        return out

    def _parse_children(self, inner: str, ci: bool, out: dict[str, object]) -> None:
        open_tag = _OPEN_TAG_CI if ci else _OPEN_TAG
        pos = 0
        while True:
            m = open_tag.search(inner, pos)
            if m is None:
                return
            tag = m.group(1)
            key = tag.lower() if ci else tag
            content_start = m.end()
            close_re = re.compile(
                "</" + re.escape(tag) + r"\s*>", re.IGNORECASE if ci else 0
            )
            close_m = close_re.search(inner, content_start)
            if close_m is not None:
                content_end = close_m.start()
                nxt = close_m.end()
            else:
                # unclosed tag: extract text up to the next sibling open tag
                sib = open_tag.search(inner, content_start)
                if sib is not None:
                    content_end = sib.start()
                    nxt = content_end
                else:
                    content_end = len(inner)
                    nxt = len(inner)
            content = inner[content_start:content_end]
            value: object
            if "<" in content:
                value = self._nested_or_text(content, ci)
            else:
                value = content.strip()
            self._accumulate(out, key, value)
            pos = nxt

    def _nested_or_text(self, content: str, ci: bool) -> object:
        nested: dict[str, object] = {}
        self._parse_children(content, ci, nested)
        return content.strip() if not nested else nested

    def _accumulate(self, out: dict[str, object], key: str, value: object) -> None:
        if key not in out:
            out[key] = value
            return
        existing = out[key]
        if isinstance(existing, list):
            existing.append(value)
        else:
            out[key] = [existing, value]
