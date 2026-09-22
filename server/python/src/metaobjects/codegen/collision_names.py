"""ADR-0044 — the package-qualified derived name for a short-name collision (shared).

``acme::alpha`` + ``Note`` → ``AcmeAlphaNote``. The one consumer is
:mod:`metaobjects.codegen.value_objects`, which assigns every value object's emitted model
name (ADR-0056); every generator that names a value object asks that module, so they all
spell a colliding one the same way.
"""
from __future__ import annotations

from metaobjects.errors import ErrorCode
from metaobjects.shared.separators import PACKAGE_SEP

#: ADR-0044 backstop error code — REUSED (never redefined) from the shared cross-port
#: error-code ledger (``metaobjects.errors.ErrorCode``), which already carries it.
ERR_PAYLOAD_NAME_COLLISION = ErrorCode.ERR_PAYLOAD_NAME_COLLISION.value


def pascal_segment(name: str) -> str:
    """``priority`` → ``Priority`` (leading char upper-cased only; no snake-splitting)
    — matches the cross-port rule for PascalCasing a bare field/package segment."""
    return name[:1].upper() + name[1:] if name else name


def package_qualified_name(pkg: str, short_name: str) -> str:
    """PascalCase each ``::``-segment of *pkg*, concatenate, append the bare
    *short_name* (``acme::alpha`` + ``Note`` → ``AcmeAlphaNote``). A root-level
    (empty-package) node keeps its bare short name — the loader's own-package
    uniqueness already precludes two root-level nodes sharing a name, so this can't
    silently under-qualify."""
    if pkg == "":
        return short_name
    return "".join(pascal_segment(seg) for seg in pkg.split(PACKAGE_SEP)) + short_name

