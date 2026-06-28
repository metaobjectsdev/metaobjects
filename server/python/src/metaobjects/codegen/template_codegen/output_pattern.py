"""Expands the cross-port output-pattern grammar (SP-1 §3.3): ``{name}``,
``{Name}`` (PascalCase), ``{package}`` (``::`` -> ``/``). An empty ``{package}``
collapses its trailing/leading slash so ``{package}/{name}`` with no package
yields just ``{name}``. Unknown placeholders raise.

Byte-equivalent to the TypeScript ``output-pattern.ts`` and the JVM
``OutputPattern``.
"""

from __future__ import annotations

import re

_TOKEN = re.compile(r"\{(\w+)\}")


def _pascal(s: str) -> str:
    return "".join(w[:1].upper() + w[1:] for w in re.split(r"[^A-Za-z0-9]+", s) if w)


def expand_output_pattern(
    pattern: str, name: str | None, package: str | None
) -> str:
    """Expand ``pattern``. ``name`` may be ``None`` (perPackage/perModel);
    ``package`` may be ``None``/empty."""
    pkg_empty = False

    def repl(m: re.Match[str]) -> str:
        nonlocal pkg_empty
        token = m.group(1)
        if token == "package":
            p = (package or "").replace("::", "/")
            if p == "":
                pkg_empty = True
            return p
        if token == "name":
            if name is None:
                raise ValueError(
                    f"output pattern {pattern!r} uses {{name}} but no entity name is in scope"
                )
            return name
        if token == "Name":
            if name is None:
                raise ValueError(
                    f"output pattern {pattern!r} uses {{Name}} but no entity name is in scope"
                )
            return _pascal(name)
        raise ValueError(f"unknown placeholder {{{token}}} in output pattern {pattern!r}")

    out = _TOKEN.sub(repl, pattern)
    if pkg_empty:
        out = re.sub(r"^/+", "", out)
        out = re.sub(r"/{2,}", "/", out)
    return out
