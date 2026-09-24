"""Stage-4 tolerant XML reader for the bounded corpus malformation set. Never throws.

Mirrors Java XmlForgivingReader: maps an element's child elements, text, AND attributes
into the field map, and handles self-closing tags (``<x a="1"/>``).

Representation:

- text-only element, no attributes      → its trimmed text (``str``) — unchanged
- self-closing / attributes-only element → a dict of attribute name→value ("" when none)
- element with child elements (± attrs)  → a dict merging attributes + child entries
  (a child element wins a name collision)
- element with text AND attributes       → a dict of the attributes plus the body text under
  :data:`TEXT_KEY` (a scalar consumer unwraps it)
- repeated sibling tags                  → a list

Carries the FR-010 fixed-behavior edge cases:

- No-throw on a leading ``</x>``.
- Unclosed tags extract their text up to the next sibling open tag.
"""
from __future__ import annotations

import re

#: Reserved key holding an element's own text content when the element is represented as a
#: dict (because it also carries attributes). ``#`` is not a legal XML name char, so it never
#: collides with a real attribute or child-element name.
TEXT_KEY = "#text"

# tag name + everything up to the closing '>' (attributes and/or a trailing '/' for a
# self-closing tag). Non-greedy so the first '>' closes the open tag.
_OPEN_TAG = re.compile(r"<([A-Za-z_][A-Za-z0-9_]*)([^>]*?)>")
_OPEN_TAG_CI = re.compile(r"<([A-Za-z_][A-Za-z0-9_]*)([^>]*?)>", re.IGNORECASE)
# a closing tag. Used to spot a STRAY close (of an element whose open never appeared in
# the body) — LLMs commonly end a block with the wrong tag.
_CLOSE_TAG = re.compile(r"</([A-Za-z_][A-Za-z0-9_]*)\s*>")
_CLOSE_TAG_CI = re.compile(r"</([A-Za-z_][A-Za-z0-9_]*)\s*>", re.IGNORECASE)
# one attribute: name = "double" | 'single' | bareword.
_ATTR = re.compile(r"""([A-Za-z_:][A-Za-z0-9_:.\-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))""")


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
        self._parse_children(inner, case_insensitive, out, None)
        return out

    def read_rootless(self, text: str | None, case_insensitive: bool) -> dict[str, object]:
        """Rootless read: parse the WHOLE text's top-level elements directly, with no
        enclosing root element to strip (a flat sequence like ``<a>..</a><b>..</b>``).
        Used for :attr:`ExtractOptions.rootless` responses. Leading/trailing non-element
        text is ignored. Never throws. Mirrors Java ``readRootless``."""
        out: dict[str, object] = {}
        if text is None or text.strip() == "":
            return out
        self._parse_children(text, case_insensitive, out, None)
        return out

    def _parse_children(
        self, inner: str, ci: bool, out: dict[str, object], loose: list[str] | None
    ) -> None:
        """Parse ``inner``'s elements into ``out``. When ``loose`` is not ``None``, the text
        BETWEEN those elements (an element's own text in mixed content) is appended to it,
        one segment per gap."""
        open_tag = _OPEN_TAG_CI if ci else _OPEN_TAG
        pos = 0
        while True:
            m = open_tag.search(inner, pos)
            if m is None:
                break
            if loose is not None:
                loose.append(inner[pos : m.start()])
            tag = m.group(1)
            key = tag.lower() if ci else tag

            raw_attrs = (m.group(2) or "").strip()
            self_closing = raw_attrs.endswith("/")
            if self_closing:
                raw_attrs = raw_attrs[:-1].strip()
            attrs = self._parse_attrs(raw_attrs, ci)

            if self_closing:
                self._accumulate(out, key, "" if not attrs else attrs)
                pos = m.end()
                continue

            content_start = m.end()
            close_re = re.compile(
                "</" + re.escape(tag) + r"\s*>", re.IGNORECASE if ci else 0
            )
            close_m = close_re.search(inner, content_start)
            if close_m is not None:
                content_end = close_m.start()
                nxt = close_m.end()
            else:
                # unclosed tag: extract content up to the next sibling open tag.
                sib = open_tag.search(inner, content_start)
                if sib is not None:
                    # When the unclosed element's content begins IMMEDIATELY with a child
                    # open tag (no leading text), that child was almost certainly meant to
                    # be NESTED, not a sibling — a common LLM malformation is dropping the
                    # parent's close tag while still emitting a real child element
                    # (e.g. <check ...><payoff>text). Absorb the remainder of this span as
                    # the unclosed element's content so the child nests under it. When there
                    # IS leading text before the first child tag (e.g. <t>hi<c>..), keep the
                    # sibling split — the leading text is the unclosed element's body and the
                    # following tag is its sibling. Mirrors Java XmlForgivingReader.
                    no_leading_text = inner[content_start : sib.start()].strip() == ""
                    if no_leading_text:
                        content_end = len(inner)
                        nxt = len(inner)
                    else:
                        content_end = sib.start()
                        nxt = content_end
                else:
                    content_end = len(inner)
                    nxt = len(inner)
                # A STRAY close tag of another element inside the unclosed element's body
                # ends the body there (the model closed the block with the wrong tag), and
                # the stray tag itself is dropped rather than kept as literal text.
                stray = self._find_stray_close(inner, content_start, content_end, ci)
                if stray is not None:
                    content_end, nxt = stray
            content = inner[content_start:content_end]
            self._accumulate(out, key, self._combine(attrs, content, ci))
            pos = nxt
        if loose is not None:
            loose.append(inner[pos:])

    def _find_stray_close(
        self, inner: str, from_: int, to: int, ci: bool
    ) -> tuple[int, int] | None:
        """The first close tag in ``inner[from_, to)`` whose element was never opened
        after ``from_`` — a stray close — as ``(start, end)``, or ``None``. A close whose
        open DID appear is a nested child's own close, not stray."""
        close_re = _CLOSE_TAG_CI if ci else _CLOSE_TAG
        at = from_
        while True:
            m = close_re.search(inner, at, to)
            if m is None:
                return None
            open_re = re.compile(
                "<" + re.escape(m.group(1)) + r"(?=[\s/>])", re.IGNORECASE if ci else 0
            )
            if open_re.search(inner, from_, m.start()) is None:
                return (m.start(), m.end())
            at = m.end()

    def _combine(self, attrs: dict[str, object], content: str, ci: bool) -> object:
        """Combine an element's attributes with its body (nested children or plain text).
        Mixed content keeps BOTH: the children, and the element's own text under
        :data:`TEXT_KEY`, so a scalar or ``@xmlText`` consumer still reads the prose
        around a child element."""
        if "<" in content:
            nested: dict[str, object] = {}
            loose: list[str] = []
            self._parse_children(content, ci, nested, loose)
            if nested:
                # attributes first; a child element wins a name collision
                merged: dict[str, object] = dict(attrs)
                merged.update(nested)
                text = self._mixed_text(loose, ci)
                if text:
                    merged[TEXT_KEY] = text
                return merged
        return self._text_value(attrs, content)

    def _mixed_text(self, segments: list[str], ci: bool) -> str:
        """The text segments between child elements: stray close tags dropped, each
        trimmed, the non-empty ones joined with a single space."""
        close_re = _CLOSE_TAG_CI if ci else _CLOSE_TAG
        parts: list[str] = []
        for seg in segments:
            t = close_re.sub("", seg).strip()
            if t:
                parts.append(t)
        return " ".join(parts)

    def _text_value(self, attrs: dict[str, object], content: str) -> object:
        text = content.strip()
        if not attrs:
            return text
        m: dict[str, object] = dict(attrs)
        m[TEXT_KEY] = text
        return m

    def _parse_attrs(self, raw_attrs: str, ci: bool) -> dict[str, object]:
        attrs: dict[str, object] = {}
        if not raw_attrs:
            return attrs
        for a in _ATTR.finditer(raw_attrs):
            name = a.group(1).lower() if ci else a.group(1)
            val = a.group(2) if a.group(2) is not None else (
                a.group(3) if a.group(3) is not None else (
                    a.group(4) if a.group(4) is not None else ""
                )
            )
            if name not in attrs:
                attrs[name] = val
        return attrs

    def _accumulate(self, out: dict[str, object], key: str, value: object) -> None:
        if key not in out:
            out[key] = value
            return
        existing = out[key]
        if isinstance(existing, list):
            existing.append(value)
        else:
            out[key] = [existing, value]
