"""Stage-4 tolerant JSON reader for the bounded corpus malformation set. Never throws.

Carries the FR-010 fixed-behavior edge cases:

- No-hang: ``{"xs":[}`` / ``{"xs":[1,`` terminate (no infinite loop).
- TRUNCATED sentinel: a present-but-cut-off/empty value is recorded as ``TRUNCATED``
  so the recover stage classifies it as MALFORMED (not LOST_REQUIRED).
"""
from __future__ import annotations

from typing import Final

# Sentinel: a key appeared in the text but its value was empty/cut-off (present-but-garbled).
TRUNCATED: Final = object()

# Max container nesting before the reader stops recursing. Python's recursion limit is far
# lower than the JVM/.NET stack, so a pathologically deep input (hundreds of nested brackets
# in adversarial LLM output) would raise RecursionError — violating the never-throws contract.
# Past this depth the container is skipped (string-aware, non-recursive) and recorded as
# garbled. Far above any realistic payload nesting.
_MAX_DEPTH: Final = 100


class JsonForgivingReader:
    def __init__(self) -> None:
        self._s: str = ""
        self._i: int = 0
        self._depth: int = 0

    def read(self, span: str | None) -> dict[str, object]:
        """Parse ``span`` as a forgiving JSON object; empty dict for garbage/non-object root."""
        self._s = span if span is not None else ""
        self._i = 0
        self._depth = 0
        self._ws()
        if self._i >= len(self._s) or self._s[self._i] != "{":
            return {}
        o = self._read_value()
        return o if isinstance(o, dict) else {}

    def _read_value(self) -> object | None:
        self._ws()
        if self._i >= len(self._s):
            return None
        c = self._s[self._i]
        if c == "{" or c == "[":
            if self._depth >= _MAX_DEPTH:
                self._skip_balanced()  # too deep: consume it, record as garbled (→ MALFORMED)
                return None
            self._depth += 1
            try:
                return self._read_object() if c == "{" else self._read_array()
            finally:
                self._depth -= 1
        if c in ('"', "'"):
            return self._read_string(c)
        return self._read_bare_scalar()

    def _skip_balanced(self) -> None:
        """Consume a balanced ``{...}``/``[...]`` (or to EOF) without recursing, string-aware."""
        depth = 0
        n = len(self._s)
        while self._i < n:
            ch = self._s[self._i]
            if ch in ('"', "'"):
                self._read_string(ch)  # advances past the quoted string (handles escapes)
                continue
            self._i += 1
            if ch == "{" or ch == "[":
                depth += 1
            elif ch == "}" or ch == "]":
                depth -= 1
                if depth <= 0:
                    return

    def _read_object(self) -> dict[str, object]:
        m: dict[str, object] = {}
        self._i += 1  # consume '{'
        while True:
            self._ws()
            if self._i >= len(self._s):
                return m  # truncation
            if self._s[self._i] == "}":
                self._i += 1
                return m
            key = self._read_key()
            if key is None:
                return m  # truncation mid-key
            self._ws()
            if self._i >= len(self._s) or self._s[self._i] != ":":
                return m  # truncation before value
            self._i += 1  # consume ':'
            self._ws()
            if self._i >= len(self._s):
                m[key] = TRUNCATED  # value cut off at EOF → present-but-garbled
                return m
            v = self._read_value()
            if v is None:
                # present key, empty/zero-width value → present-but-garbled
                m[key] = TRUNCATED
                self._ws()
                if self._i < len(self._s) and self._s[self._i] == ",":
                    self._i += 1
                    continue
                if self._i < len(self._s) and self._s[self._i] == "}":
                    self._i += 1
                return m
            m[key] = v
            self._ws()
            if self._i < len(self._s) and self._s[self._i] == ",":
                self._i += 1  # optional/trailing comma

    def _read_array(self) -> list[object]:
        xs: list[object] = []
        self._i += 1  # consume '['
        while True:
            self._ws()
            if self._i >= len(self._s):
                return xs
            if self._s[self._i] == "]":
                self._i += 1
                return xs
            if self._s[self._i] == "}":
                self._i += 1
                return xs  # malformed brace-close terminates array
            v = self._read_value()
            if v is None:
                # zero-width / no value → stop (no spin)
                self._ws()
                if self._i < len(self._s) and self._s[self._i] in ("]", "}"):
                    self._i += 1
                return xs
            xs.append(v)
            self._ws()
            if self._i < len(self._s) and self._s[self._i] == ",":
                self._i += 1
            elif self._i < len(self._s) and self._s[self._i] == "]":
                self._i += 1
                return xs
            else:
                # EOF or any other non-separator char → stop
                return xs

    def _read_key(self) -> str | None:
        self._ws()
        if self._i >= len(self._s):
            return None
        c = self._s[self._i]
        if c in ('"', "'"):
            return self._read_string(c)
        start = self._i
        while self._i < len(self._s) and (self._s[self._i].isalnum() or self._s[self._i] == "_"):
            self._i += 1
        return self._s[start : self._i] if self._i > start else None

    def _read_string(self, quote: str) -> str:
        self._i += 1  # opening quote
        out: list[str] = []
        esc = False
        while self._i < len(self._s):
            c = self._s[self._i]
            self._i += 1
            if esc:
                out.append(_unescape(c))
                esc = False
            elif c == "\\":
                esc = True
            elif c == quote:
                return "".join(out)
            else:
                out.append(c)
        return "".join(out)  # unterminated string → return what we have

    def _read_bare_scalar(self) -> str | None:
        start = self._i
        while self._i < len(self._s) and self._s[self._i] not in ",}]":
            self._i += 1
        result = self._s[start : self._i].strip()
        return result if result else None  # None = no token read (zero-width)

    def _ws(self) -> None:
        while self._i < len(self._s) and self._s[self._i].isspace():
            self._i += 1


def _unescape(c: str) -> str:
    if c == "n":
        return "\n"
    if c == "t":
        return "\t"
    if c == "r":
        return "\r"
    return c
