"""MetaSource — source.rdb node (ADR-0007).

Declares where an object's data lives. The rdb paradigm uses @table/@kind/@role/
@schema attrs; read-only-ness is derived from @kind.
"""
from __future__ import annotations

from ...meta_data import MetaData
from .source_constants import (
    DEFAULT_SOURCE_KIND,
    DEFAULT_SOURCE_ROLE,
    SOURCE_ATTR_KIND,
    SOURCE_ATTR_ROLE,
    SOURCE_ATTR_SCHEMA,
    SOURCE_ATTR_TABLE,
    SOURCE_READ_ONLY_KINDS,
)


class MetaSource(MetaData):
    """A source.* node. Accessors mirror the TS reference (meta-source.ts) and
    the Java port (MetaSource.java) — own-attr reads, with per-paradigm defaults."""

    def table_name(self) -> str | None:
        """Physical SQL table/view name from ``@table``; ``None`` if absent.

        Callers should fall back to the entity's logical name run through the
        project's columnNamingStrategy when this returns ``None``.
        """
        v = self.attr(SOURCE_ATTR_TABLE)
        return v if isinstance(v, str) and v else None

    def effective_kind(self) -> str:
        """The value of ``@kind``, defaulting to ``"table"`` when omitted
        (ADR-0007 Rule 3 — per-paradigm default)."""
        v = self.attr(SOURCE_ATTR_KIND)
        return v if isinstance(v, str) and v else DEFAULT_SOURCE_KIND

    def role(self) -> str:
        """The value of ``@role``, defaulting to ``"primary"`` when omitted."""
        v = self.attr(SOURCE_ATTR_ROLE)
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
        v = self.attr(SOURCE_ATTR_SCHEMA)
        return v if isinstance(v, str) and v else None
