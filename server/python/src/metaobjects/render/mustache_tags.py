"""One Mustache tag scanner shared by ``verify`` and the renderer's partial expansion.

Both used to find tags with their own ``{{`` search (verify) or a ``{{> x}}`` regex
(render), and neither knew what the engine knows: a comment ends at the first
closing delimiter, ``{{=<% %>=}}`` changes the delimiters, and a section close must
name the section it closes. :func:`scan` follows the Mustache spec for all three, so
the two callers cannot disagree about where a tag is.

Mirrors ``Mustache.parse`` in the TypeScript port (``mustache.js``), ``MustacheTags`` in
the C# and Java ports.
"""

from __future__ import annotations

from dataclasses import dataclass

DEFAULT_OPEN = "{{"
DEFAULT_CLOSE = "}}"

#: Tag kinds. ``name`` is a plain ``{{x}}``; ``{`` is ``{{{x}}}``; the rest are the sigil.
KIND_NAME = "name"
KIND_TRIPLE = "{"
KIND_AMP = "&"
KIND_SECTION = "#"
KIND_INVERTED = "^"
KIND_CLOSE = "/"
KIND_PARTIAL = ">"
KIND_COMMENT = "!"
KIND_DELIMITERS = "="


@dataclass(frozen=True)
class Tag:
    """One tag: its kind, its trimmed name, and its ``[start, end)`` span in the text."""

    kind: str
    value: str
    start: int
    end: int


class MustacheSyntaxError(ValueError):
    """An unbalanced section. ``section`` is the section name the finding is about:
    the unopened close's name, or the section left open."""

    def __init__(self, message: str, section: str) -> None:
        super().__init__(message)
        self.section = section


def scan(text: str) -> list[Tag]:
    """Every tag in ``text``, in order, honouring comments and delimiter changes.

    Raises :class:`MustacheSyntaxError` for a close with no open, a close that names a
    different section than the one open, or a section never closed. An unterminated tag
    ends the scan (the rest is text), as it always did here.
    """
    tags: list[Tag] = []
    open_delim, close_delim = DEFAULT_OPEN, DEFAULT_CLOSE
    open_sections: list[str] = []
    pos = 0
    while pos < len(text):
        start = text.find(open_delim, pos)
        if start < 0:
            break
        content_start = start + len(open_delim)
        triple = text.startswith("{", content_start)
        end_delim = "}" + close_delim if triple else close_delim
        if triple:
            content_start += 1
        close = text.find(end_delim, content_start)
        if close < 0:
            break
        content = text[content_start:close].strip()
        end = close + len(end_delim)
        pos = end

        if triple:
            tags.append(Tag(KIND_TRIPLE, content, start, end))
            continue
        if not content:
            continue
        sigil = content[0]
        name = content[1:].strip() if len(content) > 1 else ""
        if sigil == KIND_COMMENT:
            tags.append(Tag(KIND_COMMENT, name, start, end))
        elif sigil == KIND_DELIMITERS:
            parts = content[1:].removesuffix("=").split() if content.endswith("=") else []
            if len(parts) == 2:
                open_delim, close_delim = parts
            tags.append(Tag(KIND_DELIMITERS, name, start, end))
        elif sigil in (KIND_SECTION, KIND_INVERTED):
            open_sections.append(name)
            tags.append(Tag(sigil, name, start, end))
        elif sigil == KIND_CLOSE:
            if not open_sections:
                raise MustacheSyntaxError(f'Unopened section "{name}"', name)
            opened = open_sections.pop()
            if opened != name:
                raise MustacheSyntaxError(f'Unclosed section "{opened}"', opened)
            tags.append(Tag(KIND_CLOSE, name, start, end))
        elif sigil in (KIND_PARTIAL, KIND_AMP):
            tags.append(Tag(sigil, name, start, end))
        else:
            tags.append(Tag(KIND_NAME, content, start, end))
    if open_sections:
        opened = open_sections[-1]
        raise MustacheSyntaxError(f'Unclosed section "{opened}"', opened)
    return tags


def without_comments(text: str, tags: list[Tag]) -> str:
    """``text`` with every comment tag cut out — what a tag-presence check may scan."""
    out: list[str] = []
    pos = 0
    for tag in tags:
        if tag.kind == KIND_COMMENT:
            out.append(text[pos : tag.start])
            pos = tag.end
    out.append(text[pos:])
    return "".join(out)
