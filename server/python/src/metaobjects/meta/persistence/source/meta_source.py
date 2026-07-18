"""MetaSource — source.rdb node (ADR-0007 / FR-016 / ADR-0018).

Declares where an object's data lives. The rdb paradigm uses per-kind
physical-name aliases (@table / @view / @materializedView / @proc / @function)
+ @kind / @role / @schema attrs; read-only-ness is derived from @kind.
"""
from __future__ import annotations

from ...meta_data import MetaData
from .source_constants import (
    ALL_PHYSICAL_NAME_ALIASES,
    DEFAULT_SOURCE_KIND,
    DEFAULT_SOURCE_ROLE,
    PHYSICAL_NAME_ATTR_BY_KIND,
    SOURCE_ATTR_KIND,
    SOURCE_ATTR_ROLE,
    SOURCE_ATTR_SCHEMA,
    SOURCE_ATTR_SQL,
    SOURCE_ATTR_TABLE,
    SOURCE_ATTR_UNMANAGED,
    SOURCE_READ_ONLY_KINDS,
)


def _to_snake_case(s: str) -> str:
    """``MyName`` → ``my_name``; ``HTTPServer`` → ``http_server`` (mirrors TS
    ``toSnakeCase`` regex pair, ASCII-only)."""
    if not s:
        return s
    # Run 1: split between an uppercase-run and an upper+lower head.
    out: list[str] = []
    n = len(s)
    for i, ch in enumerate(s):
        is_upper = "A" <= ch <= "Z"
        if is_upper and i > 0:
            prev = s[i - 1]
            prev_upper = "A" <= prev <= "Z"
            prev_alnum_lower = ("a" <= prev <= "z") or ("0" <= prev <= "9")
            nxt = s[i + 1] if i + 1 < n else ""
            nxt_lower = "a" <= nxt <= "z"
            if prev_alnum_lower:
                out.append("_")
            elif prev_upper and nxt_lower:
                out.append("_")
        out.append(ch.lower())
    return "".join(out)


def _pluralize(s: str) -> str:
    """Trivial cross-port pluralization (matches TS ``pluralize``)."""
    if not s:
        return s
    lower = s.lower()
    if lower.endswith(("s", "x", "z", "ch", "sh")):
        return s + "es"
    if len(s) >= 2 and lower[-1] == "y" and lower[-2] not in "aeiou":
        return s[:-1] + "ies"
    return s + "s"


class MetaSource(MetaData):
    """A source.* node.

    ADR-0039 — attr reads RESOLVE (``get_meta_attr``): the ADR lists source attrs
    among the effective-value reads that must walk the ``extends`` chain, matching
    the Java port's resolving ``getMetaAttr(name)``. A source declared on an
    abstract base and inherited by a concrete entity must expose its @kind / @role
    / @schema / physical-name aliases through the super chain. Per-paradigm
    defaults apply when the resolved value is absent.
    """

    def table_name(self) -> str | None:
        """Physical SQL table name from the legacy ``@table`` slot. Returns
        ``None`` if absent. Kept as a back-compat slot-only accessor: callers
        should use :meth:`physical_name` for the FR-016 four-step rule.
        """
        v = self.get_meta_attr(SOURCE_ATTR_TABLE)  # ADR-0039: resolving
        return v if isinstance(v, str) and v else None

    def effective_kind(self) -> str:
        """The value of ``@kind``, defaulting to ``"table"`` when omitted
        (ADR-0007 Rule 3 — per-paradigm default)."""
        v = self.get_meta_attr(SOURCE_ATTR_KIND)  # ADR-0039: resolving
        return v if isinstance(v, str) and v else DEFAULT_SOURCE_KIND

    def role(self) -> str:
        """The value of ``@role``, defaulting to ``"primary"`` when omitted."""
        v = self.get_meta_attr(SOURCE_ATTR_ROLE)  # ADR-0039: resolving
        return v if isinstance(v, str) and v else DEFAULT_SOURCE_ROLE

    def is_read_only(self) -> bool:
        """True when ``@kind`` names a read-only construct (view,
        materializedView, storedProc, tableFunction)."""
        return self.effective_kind() in SOURCE_READ_ONLY_KINDS

    def is_writable(self) -> bool:
        """True when this source is writable (i.e. not read-only)."""
        return not self.is_read_only()

    def schema(self) -> str | None:
        """The value of ``@schema``, or ``None`` if absent."""
        v = self.get_meta_attr(SOURCE_ATTR_SCHEMA)  # ADR-0039: resolving
        return v if isinstance(v, str) and v else None

    def sql_body(self) -> str | None:
        """FR-024/#208 — the hand-written SQL body for this source's DB object,
        when declared via ``@sql``, narrowed to a non-empty string (else
        ``None``). The tool registers + fingerprints + drift-checks this body
        but never authors or parses it."""
        v = self.get_meta_attr(SOURCE_ATTR_SQL)  # ADR-0039: resolving — an
        # inherited source's @sql lives on the super node (follows the
        # @role/effective_kind precedent).
        return v if isinstance(v, str) and v else None

    def is_unmanaged(self) -> bool:
        """FR-024/#208 — true when this source's DB object is managed
        elsewhere (Flyway / a hand-migration owns its DDL); ``meta migrate``
        does not create/drop/drift-check it."""
        # ADR-0039: resolving — an inherited source's @unmanaged lives on the
        # super node.
        return self.get_meta_attr(SOURCE_ATTR_UNMANAGED) is True

    def physical_name(self) -> str:
        """Resolved physical SQL name for this source (FR-016 / ADR-0018).

        Four-step rule:
            1. Kind-matching alias (e.g. ``@proc`` when ``@kind: "storedProc"``).
            2. Legacy ``@table`` for non-table kind (pre-1.0 fallback).
            3. Source's bare structural ``name`` via snake_case
               (no pluralize — the source's name IS the logical name).
            4. Owning entity's name via ``pluralize(snake_case())``.

        Callers needing the legacy raw ``@table`` slot only should use
        :meth:`table_name`; codegen / runtime should use ``physical_name``.
        """
        kind = self.effective_kind()

        # Step 1: kind-matching alias.
        canonical_attr = PHYSICAL_NAME_ATTR_BY_KIND.get(kind)
        if canonical_attr is not None:
            v = self.get_meta_attr(canonical_attr)  # ADR-0039: resolving
            if isinstance(v, str) and v:
                return v

        # Step 2: legacy @table for non-table kind.
        if canonical_attr != SOURCE_ATTR_TABLE:
            legacy = self.get_meta_attr(SOURCE_ATTR_TABLE)  # ADR-0039: resolving
            if isinstance(legacy, str) and legacy:
                return legacy

        # Step 3: source's structural name → snake_case (no pluralize).
        if self.name:
            return _to_snake_case(self.name)

        # Step 4: owning entity's name → pluralize(snake_case).
        owner = self.parent
        if owner is not None and getattr(owner, "name", ""):
            return _pluralize(_to_snake_case(owner.name))

        return ""


__all__ = ["MetaSource", "ALL_PHYSICAL_NAME_ALIASES"]
