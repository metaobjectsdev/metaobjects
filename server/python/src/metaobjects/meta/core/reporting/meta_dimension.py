"""MetaDimension — concrete node class for type=dimension nodes (FR-044).

Extends MetaData directly. Accessors are RESOLVING (ADR-0039): a dimension
declared on an abstract base entity is read through the same accessors as one
declared on the concrete entity. Python naming inversion: ``attr()`` is OWN-ONLY
here, so every read below goes through the resolving ``get_meta_attr()``.
Mirrors TS ``core/reporting/meta-dimension.ts``.
"""
from __future__ import annotations

from ...meta_data import MetaData
from .reporting_constants import (
    DIMENSION_SUBTYPE_TIME,
    REPORTING_ATTR_GRAINS,
    REPORTING_ATTR_OF,
    REPORTING_ATTR_VIA,
    TIME_GRAINS,
)


class MetaDimension(MetaData):
    def is_time(self) -> bool:
        """True for ``dimension.time`` (grain truncation); False for ``dimension.attribute``."""
        return self.sub_type == DIMENSION_SUBTYPE_TIME

    def of(self) -> str | None:
        """ADR-0039: resolving. Dotted ``Entity.field`` reference naming the grouped column."""
        v = self.get_meta_attr(REPORTING_ATTR_OF)
        return v if isinstance(v, str) else None

    def via(self) -> str | None:
        """ADR-0039: resolving. Optional dotted to-one relationship path from the
        owning entity to the ``@of`` entity."""
        v = self.get_meta_attr(REPORTING_ATTR_VIA)
        return v if isinstance(v, str) else None

    def grains(self) -> list[str]:
        """ADR-0039: resolving. The grains a ``dimension.time`` supports (empty for
        ``dimension.attribute``); unknown values are dropped."""
        v = self.get_meta_attr(REPORTING_ATTR_GRAINS)
        items: list[object] = list(v) if isinstance(v, list) else [v] if isinstance(v, str) else []
        return [g for g in items if isinstance(g, str) and g in TIME_GRAINS]
