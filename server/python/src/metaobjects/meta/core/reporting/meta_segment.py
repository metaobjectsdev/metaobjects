"""MetaSegment — concrete node class for type=segment nodes (FR-044).

Extends MetaData directly. Accessors are RESOLVING (ADR-0039) — Python naming
inversion: ``attr()`` is OWN-ONLY here, so the read goes through
``get_meta_attr()``. Mirrors TS ``core/reporting/meta-segment.ts``.
"""
from __future__ import annotations

from ...meta_data import MetaData
from .reporting_constants import REPORTING_ATTR_FILTER


class MetaSegment(MetaData):
    def filter(self) -> dict[str, object] | None:
        """ADR-0039: resolving. The named row scope: a canonical attr.filter over the
        declaring entity's fields."""
        v = self.get_meta_attr(REPORTING_ATTR_FILTER)
        return v if isinstance(v, dict) else None
