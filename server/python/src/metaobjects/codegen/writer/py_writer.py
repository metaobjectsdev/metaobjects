"""The Python dialect of the code writer (ADR-0063; contract: ``spec/code-writer.md``).

Adds what is Python's own: imports collected while the body is written and printed first,
string quoting, suites (a block that closes by dedenting, with no closing token) and
docstrings. Four-space indent, 88 columns and a trailing comma in a broken list are its
defaults; none of that is a formatter's doing, the writer lays the text out itself.
"""
from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field

from .code_writer import (
    ERR_WRITER_IMPORT_CONFLICT,
    CodeWriter,
    Group,
    Piece,
    WriterError,
    group,
)

__all__ = ["PyWriter", "str_lit", "call", "seq", "mapping", "kwarg"]

FUTURE_MODULE = "__future__"


def str_lit(value: str) -> str:
    """A correctly quoted Python string literal (double-quoted, ``\\n`` escaped)."""
    return json.dumps(value, ensure_ascii=False)


def call(fn: str, args: "list[object] | tuple[object, ...]") -> Group:
    """A call: ``fn(a, b)``."""
    return group(f"{fn}(", list(args), ")")  # type: ignore[arg-type]


def seq(items: "list[object] | tuple[object, ...]", open_: str = "[", close: str = "]") -> Group:
    """A list literal ``[a, b]`` (pass ``("(", ")")`` for a tuple)."""
    return group(open_, list(items), close)  # type: ignore[arg-type]


def mapping(entries: "list[tuple[object, object]]") -> Group:
    """A dict literal ``{k: v, ...}``; keys and values are written as given."""
    return group("{", [[k, ": ", v] for k, v in entries], "}")  # type: ignore[arg-type]


def kwarg(name: str, value: object) -> Piece:
    """``name=value``."""
    return [name, "=", value]  # type: ignore[list-item]


@dataclass
class _ModuleImports:
    #: local name -> exported name
    named: dict[str, str] = field(default_factory=dict)
    #: ``import module`` / ``import module as alias`` -> the alias (or the module itself)
    plain: set[str] = field(default_factory=set)


class PyWriter(CodeWriter):
    """The Python writer. Built to be extended: each section of the file
    (``write_header``, ``write_imports``, ``write_import``, ``order_modules``) is its own
    overridable method, and none of them is a stability contract."""

    def __init__(
        self, indent: str = "    ", width: int = 88, trailing_comma: bool = True
    ) -> None:
        super().__init__(indent=indent, width=width, trailing_comma=trailing_comma)
        self._modules: dict[str, _ModuleImports] = {}
        #: local name -> the module it was imported from, so one name cannot come from two
        self._locals: dict[str, str] = {}
        self._head: list[str] = []

    # ── imports ──────────────────────────────────────────────────────────────────────

    def use(self, name: str, from_: str, as_: str | None = None) -> str:
        """Reference ``from <from_> import <name> [as <as_>]``; returns the name to write."""
        local = as_ or name
        self._claim(local, from_)
        mod = self._module(from_)
        seen = mod.named.get(local)
        if seen is not None and seen != name:
            raise WriterError(
                ERR_WRITER_IMPORT_CONFLICT,
                f"{local} from {from_} names both {seen} and {name}",
            )
        mod.named[local] = name
        return local

    def use_module(self, module: str, as_: str | None = None) -> str:
        """Reference ``import <module> [as <as_>]``; returns the name to write."""
        local = as_ or module.split(".")[0]
        self._claim(local, module if as_ else local)
        self._module(module).plain.add(as_ or "")
        return local

    def use_future(self, name: str = "annotations") -> None:
        """``from __future__ import <name>``: always printed first."""
        self.use(name, FUTURE_MODULE)

    def header(self, *lines: str) -> "PyWriter":
        """Lines printed at the very top, before the imports: a banner comment."""
        self._head.extend(lines)
        return self

    # ── members ──────────────────────────────────────────────────────────────────────

    def suite(self, head: object, body: Callable[[], None]) -> "PyWriter":
        """``open(head)``, the body, then dedent: a Python block has no closing token. A
        blank-line request made at the end of the body is kept, so a gap before the next
        top-level definition survives the dedent."""
        self.open(head)
        body()
        return self.dedent()

    def dedent(self) -> "PyWriter":
        """End the suite opened by ``open`` without writing a line."""
        self._dedent("dedent()")
        return self

    def gap(self) -> "PyWriter":
        """Two blank lines before whatever is written next: the gap between top-level
        definitions."""
        self._want_blank = max(self._want_blank, 2)
        return self

    def doc(self, *lines: str) -> "PyWriter":
        """A docstring at the current indent: one line when it fits, otherwise a block with
        the closing quotes on their own line. An empty entry is a blank line. A backslash is
        written as ``\\\\`` and ``\"\"\"`` in the text is escaped."""
        for ln in self._doc_lines(lines, len(self._prefix())):
            self.line(ln)
        return self

    def module_doc(self, *lines: str) -> "PyWriter":
        """The module docstring. It is a header line group, so it prints before the imports
        (a ``from __future__`` import must follow it)."""
        self._head.extend(self._doc_lines(lines, 0))
        return self

    def _doc_lines(self, lines: "tuple[str, ...]", depth: int) -> list[str]:
        if not lines:
            return []
        safe = [ln.replace("\\", "\\\\").replace('"""', '\\"\\"\\"') for ln in lines]
        one = f'"""{safe[0]}"""'
        if len(safe) == 1 and depth + len(one) <= self.width:
            return [one]
        return [f'"""{safe[0]}', *safe[1:], '"""']

    # ── output ───────────────────────────────────────────────────────────────────────

    def to_string(self) -> str:
        # A Python suite ends where the file does, so a suite still open here is closed
        # for the generator (the core's ERR_WRITER_UNCLOSED_BLOCK is for closing tokens).
        self._openers.clear()
        head = self._section_writer()
        self.write_header(head)
        head.blank()
        self.write_imports(head)
        top = head.to_string()
        body = super().to_string()
        if top == "":
            return body
        if body == "":
            return top
        return f"{top}\n{body}"

    def _section_writer(self) -> CodeWriter:
        return CodeWriter(indent=self.indent, width=self.width, trailing_comma=self.trailing_comma)

    def write_header(self, w: CodeWriter) -> None:
        """The ``header(...)`` lines, as given."""
        for ln in self._head:
            w.line(ln)

    def write_imports(self, w: CodeWriter) -> None:
        """Every collected import, one blank line between the ``__future__`` import, the
        absolute modules and the relative ones. In a section the plain ``import m`` lines
        come first, then the ``from m import ...`` lines, each in ``order_modules`` order."""
        for n, mods in enumerate(self.order_modules(list(self._modules))):
            if n > 0:
                w.blank()
            for m in mods:
                self.write_plain_imports(w, m, self._modules[m])
            for m in mods:
                self.write_from_import(w, m, self._modules[m])

    def order_modules(self, modules: list[str]) -> list[list[str]]:
        """Three sections: ``__future__``, then absolute modules, then relative ones, each
        in code-point order."""
        future = [m for m in modules if m == FUTURE_MODULE]
        relative = sorted(m for m in modules if m.startswith("."))
        absolute = sorted(m for m in modules if m != FUTURE_MODULE and not m.startswith("."))
        return [s for s in (future, absolute, relative) if s]

    def write_plain_imports(self, w: CodeWriter, from_: str, m: _ModuleImports) -> None:
        for alias in sorted(m.plain):
            w.line(f"import {from_} as {alias}" if alias else f"import {from_}")

    def write_from_import(self, w: CodeWriter, from_: str, m: _ModuleImports) -> None:
        if not m.named:
            return
        items = [
            local if exported == local else f"{exported} as {local}"
            for local, exported in sorted(m.named.items())
        ]
        one = f"from {from_} import " + ", ".join(items)
        if len(items) == 1 or w.fits(one):
            # One name never breaks: it stays on one line however long the module is.
            w.line(one)
        else:
            # A parenthesised list, one name per line with a trailing comma.
            w.open(f"from {from_} import (")
            for item in items:
                w.line(item, ",")
            w.close(")")

    # ── internals ────────────────────────────────────────────────────────────────────

    def _claim(self, local: str, from_: str) -> None:
        owner = self._locals.get(local)
        if owner is not None and owner != from_:
            raise WriterError(
                ERR_WRITER_IMPORT_CONFLICT, f"{local} is imported from both {owner} and {from_}"
            )
        self._locals[local] = from_

    def _module(self, from_: str) -> _ModuleImports:
        m = self._modules.get(from_)
        if m is None:
            m = _ModuleImports()
            self._modules[from_] = m
        return m
