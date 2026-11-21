"""The layout ratchet's analyzer (ADR-0063): finds layout a generator typed by hand.

Generators say what a line contains and the writer decides where it sits, so generator
source should never spell a line break or an indentation run. This reads a source file with
Python's own parser (``ast``) and walks the syntax tree. Working on the tree, not the text,
is what makes the rules exact: comments are never nodes, a string's value is the parser's
value (so ``"\\n"`` and a line break inside a triple-quoted string are the same finding), and
a constant is followed to its same-file assignment, so ``NL = "\\n"; NL.join(xs)`` is a
finding at the join as well as at the assignment.

Four rules (the same four as every port's ratchet):

  newline-literal  a string, or one part of an f-string, whose value contains a line break.
  indent-literal   a string (or the head of an f-string) that begins with an indentation run:
                   two or more spaces, or a tab.
  newline-join     ``sep.join(xs)`` whose separator contains a line break, the separator
                   resolved through same-file constants.
  indent-repeat    ``s * n`` where ``s`` resolves to whitespace: building indentation.

Places a literal is not output, and so is not layout, are ruled out by position:

  - a docstring (the first statement of a module, class or function);
  - a search pattern: the first argument of ``split``, ``rsplit``, ``find``, ``rfind``,
    ``index``, ``count``, ``startswith``, ``endswith``, ``replace``, ``partition``,
    ``strip``, ``lstrip`` or ``rstrip``;
  - a comparison operand (``x == "\\n"``, ``"\\n" in x``): it is read, not written;
  - a writer snippet: the argument of a ``.text(...)`` call, the writer's entry for fixed code
    written as it should read.
"""
from __future__ import annotations

import ast
import re
from dataclasses import dataclass
from pathlib import Path

LINE_BREAK = re.compile(r"[\r\n]")
INDENT_RUN = re.compile(r"^(?: {2,}|\t)")
WHITESPACE = re.compile(r"^[ \t\r\n]+$")
SEARCH_METHODS = frozenset(
    {
        "split", "rsplit", "splitlines", "find", "rfind", "index", "rindex", "count",
        "startswith", "endswith", "replace", "partition", "rpartition", "strip", "lstrip",
        "rstrip",
    }
)
SNIPPET_METHOD = "text"
MAX_RESOLVE_DEPTH = 8


@dataclass(frozen=True)
class Finding:
    kind: str
    line: int
    column: int
    excerpt: str


@dataclass(frozen=True)
class _Resolved:
    text: str
    complete: bool


def analyze_source(source: str, filename: str = "<fixture>") -> list[Finding]:
    return _Analyzer(source, filename).run()


def is_generator_source(relative: Path) -> bool:
    """Scope by rule, not by list: every module under ``codegen/`` except the writer."""
    parts = relative.parts
    return relative.suffix == ".py" and "writer" not in parts and "__pycache__" not in parts


class _Analyzer:
    def __init__(self, source: str, filename: str) -> None:
        self.tree = ast.parse(source, filename)
        self.lines = source.splitlines()
        self.findings: list[Finding] = []
        self.skip: set[int] = set()
        self.consts: dict[str, ast.expr] = {}

    def run(self) -> list[Finding]:
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Assign) and len(node.targets) == 1:
                t = node.targets[0]
                if isinstance(t, ast.Name):
                    self.consts[t.id] = node.value
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value:
                self.consts[node.target.id] = node.value
        self._mark_skips()
        for node in ast.walk(self.tree):
            self._visit(node)
        self.findings.sort(key=lambda f: (f.line, f.column, f.kind))
        return self.findings

    # ── positions that are not output ────────────────────────────────────────────────

    def _skip_tree(self, node: ast.AST) -> None:
        for n in ast.walk(node):
            self.skip.add(id(n))

    def _mark_skips(self) -> None:
        for node in ast.walk(self.tree):
            if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                body = node.body
                if (
                    body
                    and isinstance(body[0], ast.Expr)
                    and isinstance(body[0].value, ast.Constant)
                    and isinstance(body[0].value.value, str)
                ):
                    self._skip_tree(body[0].value)
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                if node.func.attr in SEARCH_METHODS and node.args:
                    self._skip_tree(node.args[0])
                elif node.func.attr == SNIPPET_METHOD:
                    for a in node.args:
                        self._skip_tree(a)
            elif isinstance(node, ast.Compare):
                self._skip_tree(node.left)
                for c in node.comparators:
                    self._skip_tree(c)

    # ── the rules ────────────────────────────────────────────────────────────────────

    def _add(self, kind: str, node: ast.AST) -> None:
        line = getattr(node, "lineno", 1)
        col = getattr(node, "col_offset", 0) + 1
        text = self.lines[line - 1].strip() if 0 < line <= len(self.lines) else ""
        self.findings.append(Finding(kind, line, col, text[:80]))

    def _visit(self, node: ast.AST) -> None:
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if id(node) in self.skip:
                return
            if LINE_BREAK.search(node.value):
                self._add("newline-literal", node)
            if self._starts_a_line(node) and INDENT_RUN.match(node.value):
                self._add("indent-literal", node)
        elif isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Attribute) and f.attr == "join" and id(node) not in self.skip:
                r = self._resolve(f.value)
                if r is not None and LINE_BREAK.search(r.text):
                    self._add("newline-join", node)
        elif isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mult):
            if id(node) in self.skip:
                return
            for side, other in ((node.left, node.right), (node.right, node.left)):
                r = self._resolve(side)
                if r is not None and r.complete and r.text and WHITESPACE.match(r.text):
                    if not self._is_string(other):
                        self._add("indent-repeat", node)
                        break

    def _starts_a_line(self, node: ast.Constant) -> bool:
        """A string is the head of its output unless it is a later part of an f-string."""
        parent = self.parents.get(id(node)) if hasattr(self, "parents") else None
        if isinstance(parent, ast.JoinedStr):
            return parent.values[0] is node
        return True

    @property
    def parents(self) -> dict[int, ast.AST]:
        if "_parents" not in self.__dict__:
            m: dict[int, ast.AST] = {}
            for p in ast.walk(self.tree):
                for c in ast.iter_child_nodes(p):
                    m[id(c)] = p
            self.__dict__["_parents"] = m
        return self.__dict__["_parents"]

    def _is_string(self, node: ast.expr) -> bool:
        r = self._resolve(node)
        return r is not None and r.complete

    # ── a constant cannot hide a line break ──────────────────────────────────────────

    def _resolve(self, node: ast.expr, depth: int = 0) -> _Resolved | None:
        if depth > MAX_RESOLVE_DEPTH:
            return None
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return _Resolved(node.value, True)
        if isinstance(node, ast.Name) and node.id in self.consts:
            return self._resolve(self.consts[node.id], depth + 1)
        if isinstance(node, ast.JoinedStr):
            text, complete = "", True
            for v in node.values:
                if isinstance(v, ast.Constant) and isinstance(v.value, str):
                    text += v.value
                else:
                    complete = False
            return _Resolved(text, complete)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            a, b = self._resolve(node.left, depth + 1), self._resolve(node.right, depth + 1)
            if a is None and b is None:
                return None
            return _Resolved((a.text if a else "") + (b.text if b else ""), bool(a and b and a.complete and b.complete))
        if isinstance(node, ast.IfExp):
            a, b = self._resolve(node.body, depth + 1), self._resolve(node.orelse, depth + 1)
            if a is None and b is None:
                return None
            # Either branch of a conditional separator counts.
            text = (a.text if a else "") if (a and LINE_BREAK.search(a.text)) else (b.text if b else "")
            return _Resolved(text, False)
        return None
