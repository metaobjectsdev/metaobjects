"""FR-023 §4.3 — the scope-pattern grammar.

A line-for-line port of the TypeScript scope engine
(``server/typescript/packages/metadata/src/scope.ts``): a pure, no-I/O module
deciding whether a fully-qualified node name falls inside a consumer's
declared ``include``/``exclude`` scope. A cross-language conformance corpus
(``fixtures/scope-conformance/cases.json``) pins its semantics exactly, so
pattern behavior must match TS (and the other ports) byte-for-byte.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional, Sequence

from .errors import ErrorCode, ParseError
from .shared.separators import PACKAGE_SEP

# One package segment: any run of characters containing no separator char.
_SEGMENT = "[^:]+"
# One or more segments, separator-joined — the "**" expansion.
_SEGMENTS = f"{_SEGMENT}(?:{PACKAGE_SEP}{_SEGMENT})*"

# Regex metacharacters to escape for literal matching. Mirrors TS
# `escapeLiteral`'s `/[.*+?^${}()|[\]\\]/g` character class exactly.
_METACHAR_RE = re.compile(r"[.*+?^${}()|\[\]\\]")


def _escape_literal(text: str) -> str:
    return _METACHAR_RE.sub(lambda m: "\\" + m.group(0), text)


def _compile_segment(segment: str, pattern: str) -> str:
    """Compile one segment. ``**`` spans segments; ``*`` never crosses a separator."""
    if len(segment) == 0:
        raise ParseError(
            f'empty segment in scope pattern "{pattern}"',
            ErrorCode.ERR_SCOPE_PATTERN_INVALID,
        )
    # A segment surviving the split on the two-character PACKAGE_SEP ("::")
    # can still contain a lone ":" when the pattern has an odd colon run —
    # e.g. "acme:::Order".split("::") => ["acme", ":Order"]. _SEGMENT
    # ([^:]+) already excludes ":" from a well-formed segment, so a leftover
    # ":" here means the separator was malformed, not that ":" is meant
    # literally. Left unchecked, _escape_literal treats it as a literal
    # character and compiles a regex requiring three colons in a row —
    # which no legal "::"-joined fully-qualified name can ever contain, so
    # the pattern would silently match nothing instead of failing loud.
    if ":" in segment:
        raise ParseError(
            f'scope pattern "{pattern}" has a malformed separator (an odd run '
            'of ":") — segments are joined by "::", never a single ":"',
            ErrorCode.ERR_SCOPE_PATTERN_INVALID,
        )
    if segment == "**":
        return f"(?:{_SEGMENTS})"
    # `*` inside a segment matches any characters except the separator char.
    return "[^:]*".join(_escape_literal(part) for part in segment.split("*"))


def compile_pattern(pattern: str) -> "re.Pattern[str]":
    if len(pattern) == 0:
        raise ParseError(
            "scope pattern must not be empty",
            ErrorCode.ERR_SCOPE_PATTERN_INVALID,
        )
    body = PACKAGE_SEP.join(
        _compile_segment(segment, pattern) for segment in pattern.split(PACKAGE_SEP)
    )
    return re.compile(f"^{body}$")


@dataclass(frozen=True)
class CompiledScope:
    include: tuple["re.Pattern[str]", ...]
    exclude: tuple["re.Pattern[str]", ...]


def compile_scope(
    include: Optional[Sequence[str]] = None,
    exclude: Optional[Sequence[str]] = None,
) -> CompiledScope:
    """Absent or empty ``include`` means "everything"; ``exclude`` is applied after."""
    return CompiledScope(
        include=tuple(compile_pattern(p) for p in (include or ())),
        exclude=tuple(compile_pattern(p) for p in (exclude or ())),
    )


def matches_scope(fqn: str, compiled: CompiledScope) -> bool:
    """True when ``fqn`` is inside the scope. An empty ``include`` means everything."""
    included = len(compiled.include) == 0 or any(p.match(fqn) for p in compiled.include)
    if not included:
        return False
    return not any(p.match(fqn) for p in compiled.exclude)
