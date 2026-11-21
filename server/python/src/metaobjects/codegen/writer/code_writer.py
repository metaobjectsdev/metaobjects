"""The language-neutral code writer (ADR-0063; contract: ``spec/code-writer.md``).

A generator says WHAT a line contains; the writer decides WHERE it sits. It builds the file
in memory and returns a string, so nothing here touches the disk and no formatter runs over
the result. It never parses the text it is handed: it lays out the structure the generator
gave it — lines, blocks, blank-line requests and breakable lists.

This module and the dialect beside it are the ONLY codegen source allowed to type layout
(newlines, indentation). ``tests/codegen/test_layout_ratchet.py`` holds every other
generator module to that.
"""
from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Union

#: Error codes a writer raises. Shared by every port's writer (spec/code-writer.md).
ERR_WRITER_UNBALANCED_CLOSE = "ERR_WRITER_UNBALANCED_CLOSE"
ERR_WRITER_UNCLOSED_BLOCK = "ERR_WRITER_UNCLOSED_BLOCK"
ERR_WRITER_NEWLINE_IN_LINE = "ERR_WRITER_NEWLINE_IN_LINE"
ERR_WRITER_IMPORT_CONFLICT = "ERR_WRITER_IMPORT_CONFLICT"
ERR_WRITER_UNKNOWN_PIECE = "ERR_WRITER_UNKNOWN_PIECE"


class WriterError(Exception):
    """A writer failure: one of the shared codes plus a message for people."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


@dataclass(frozen=True)
class Group:
    """A bracketed, comma-separated list. Printed on one line when the line fits the
    width; otherwise opener, one item per line (each followed by a comma) and closer."""

    open: str
    items: tuple["Piece", ...]
    close: str
    #: ``{ a, b }`` (True) versus ``[a, b]`` or ``f(a, b)`` (False) on one line.
    pad: bool = False


#: An expression fragment: text, a breakable list, or a concatenation of fragments.
Piece = Union[str, Group, tuple, list]


def group(open_: str, items: "list[Piece] | tuple[Piece, ...]", close: str, pad: bool = False) -> Group:
    """A list with no padding inside its brackets (``[a, b]``, ``f(a, b)``) by default."""
    return Group(open_, tuple(items), close, pad)


_ANY_LINE_BREAK = re.compile(r"\r\n?|\n")
_NEWLINE = "\n"


def flat(p: Piece) -> str:
    """A piece printed on one line."""
    if isinstance(p, str):
        return p
    if isinstance(p, Group):
        if not p.items:
            return p.open + p.close
        inner = ", ".join(flat(i) for i in p.items)
        return f"{p.open} {inner} {p.close}" if p.pad else p.open + inner + p.close
    return "".join(flat(x) for x in p)


def _last_group(p: Piece) -> tuple[str, Group, str] | None:
    """Split a piece around its LAST non-empty list: (text before, the list, text after)."""
    if isinstance(p, str):
        return None
    if isinstance(p, Group):
        return None if not p.items else ("", p, "")
    parts = list(p)
    for i in range(len(parts) - 1, -1, -1):
        hit = _last_group(parts[i])
        if hit is not None:
            return (flat(parts[:i]) + hit[0], hit[1], hit[2] + flat(parts[i + 1 :]))
    return None


class CodeWriter:
    """The core writer. Built to be extended (ADR-0063): every method is public or
    protected-by-convention, so a dialect or an adopter's subclass overrides the one step it
    needs (``piece``, ``break_at``, ``fits``). These methods are not a stability contract."""

    def __init__(self, indent: str = "    ", width: int = 88, trailing_comma: bool = True) -> None:
        self.indent = indent
        self.width = width
        self.trailing_comma = trailing_comma
        self._out: list[str] = []
        #: The text of each line that opened a block still open, outermost first.
        self._openers: list[str] = []
        self._want_blank = 0
        #: True at the start of the file and right after a block opens.
        self._at_block_start = True

    # ── the public surface ───────────────────────────────────────────────────────────

    def line(self, *parts: object) -> "CodeWriter":
        """One line at the current indent. The parts are concatenated; when the line does
        not fit the width, the LAST non-empty list in it is printed one item per line. A
        line whose text is empty is a blank-line request."""
        return self._put(self.piece(parts))

    def blank(self) -> "CodeWriter":
        """Ask for one blank line before whatever is written next. Requests never stack."""
        self._want_blank = max(self._want_blank, 1)
        return self

    def open(self, *parts: object) -> "CodeWriter":
        """Write the line that opens a block, then indent."""
        return self._open_piece(self.piece(parts))

    def close(self, *parts: object) -> "CodeWriter":
        """Dedent, then write the line that closes the block."""
        return self._close_piece(self.piece(parts))

    def block(self, head: object, body: Callable[[], None], tail: object = "}") -> "CodeWriter":
        """``open(head)``, the body, then ``close(tail)``: the indent cannot be left
        unbalanced."""
        self.open(head)
        body()
        return self.close(tail)

    def text(self, snippet: str) -> "CodeWriter":
        """A multi-line snippet written as it should read. Its common left margin is
        removed and it is re-indented to the current level; a blank line in it is a
        blank-line request. Every line is re-indented, including lines inside a multi-line
        string literal."""
        lines = _ANY_LINE_BREAK.split(snippet)
        if len(lines) > 1 and lines[0].strip() == "":
            lines.pop(0)
        if lines and lines[-1].strip() == "":
            lines.pop()
        margin = min(
            (len(ln) - len(ln.lstrip()) for ln in lines if ln.strip() != ""), default=0
        )
        for ln in lines:
            if ln.strip() == "":
                self.blank()
            else:
                self._put(ln[margin:])
        return self

    def to_string(self) -> str:
        """The finished file: ``\\n`` line endings, no trailing whitespace, one final
        newline (none when empty). Raises if a block is still open."""
        body = self._body()
        return "" if body == "" else body + _NEWLINE

    def __str__(self) -> str:
        return self.to_string()

    # ── the steps a dialect or subclass overrides ────────────────────────────────────

    def piece(self, p: object) -> Piece:
        """Turn one argument of ``line()`` into a writer piece. A dialect overrides this to
        accept its own fragment types and calls ``super`` for the rest."""
        if isinstance(p, str):
            return p
        if isinstance(p, Group):
            items = tuple(self.piece(i) for i in p.items)
            if all(a is b for a, b in zip(items, p.items)):
                return p
            return Group(p.open, items, p.close, p.pad)
        if isinstance(p, (list, tuple)):
            return tuple(self.piece(x) for x in p)
        raise WriterError(ERR_WRITER_UNKNOWN_PIECE, f"cannot write {_describe(p)}")

    def fits(self, text: str) -> bool:
        """Whether ``text`` fits on one line at the current indent."""
        return len(self._prefix()) + len(text) <= self.width

    def break_at(self, piece: Piece) -> tuple[str, Group, str] | None:
        """Where a line that does not fit breaks: (text before, the list that breaks, text
        after), or ``None`` to print the line as it is. Default: the LAST non-empty list."""
        return _last_group(piece)

    # ── internals ────────────────────────────────────────────────────────────────────

    def _body(self) -> str:
        if self._openers:
            raise WriterError(
                ERR_WRITER_UNCLOSED_BLOCK, f"unclosed block opened by: {self._openers[-1]}"
            )
        return _NEWLINE.join(self._out)

    def _prefix(self) -> str:
        return self.indent * len(self._openers)

    def _open_piece(self, piece: Piece) -> "CodeWriter":
        self._put(piece)
        self._openers.append(flat(piece).strip())
        self._at_block_start = True
        return self

    def _close_piece(self, piece: Piece) -> "CodeWriter":
        self._dedent(f"close({flat(piece)!r})")
        self._want_blank = 0
        return self._put(piece)

    def _dedent(self, what: str) -> None:
        if not self._openers:
            raise WriterError(ERR_WRITER_UNBALANCED_CLOSE, f"{what} with no block open")
        self._openers.pop()

    def _put(self, piece: Piece) -> "CodeWriter":
        raw = flat(piece)
        if _ANY_LINE_BREAK.search(raw):
            raise WriterError(
                ERR_WRITER_NEWLINE_IN_LINE,
                "line text contains a line break; write each line separately or use "
                f"text(): {raw!r}",
            )
        text = raw.rstrip()
        if text == "":
            return self.blank()
        if not self._at_block_start:
            self._out.extend([""] * self._want_blank)
        self._want_blank = 0
        self._at_block_start = False
        pre = self._prefix()
        split = None if self.fits(text) else self.break_at(piece)
        if split is None:
            self._out.append(pre + text)
            return self
        before, grp, after = split
        self._open_piece(before + grp.open)
        last = len(grp.items) - 1
        for n, item in enumerate(grp.items):
            comma = "," if n < last or self.trailing_comma else ""
            self._put((item, comma))
        return self._close_piece(grp.close + after)


def _describe(p: object) -> str:
    if p is None:
        return "None"
    return f"an object ({type(p).__name__})"
