"""MetaMeasure — concrete node class for type=measure nodes (FR-044).

Extends MetaData directly. Accessors are RESOLVING (ADR-0039) — Python naming
inversion: ``attr()`` is OWN-ONLY here, so every read goes through
``get_meta_attr()``. Mirrors TS ``core/reporting/meta-measure.ts``.
"""
from __future__ import annotations

from ...meta_data import MetaData
from .reporting_constants import (
    MEASURE_AGGS,
    MEASURE_SUBTYPE_RATIO,
    REPORTING_ATTR_AGG,
    REPORTING_ATTR_DEFAULT,
    REPORTING_ATTR_DENOMINATOR,
    REPORTING_ATTR_DISTINCT,
    REPORTING_ATTR_FILTER,
    REPORTING_ATTR_NUMERATOR,
    REPORTING_ATTR_OF,
    REPORTING_ATTR_SEGMENT,
)


def _optional_string(v: object) -> str | None:
    return v if isinstance(v, str) else None


class MetaMeasure(MetaData):
    def is_ratio(self) -> bool:
        """True for ``measure.ratio``; False for ``measure.aggregate``."""
        return self.sub_type == MEASURE_SUBTYPE_RATIO

    def agg(self) -> str | None:
        """ADR-0039: resolving. The aggregate function (``measure.aggregate`` only)."""
        v = self.get_meta_attr(REPORTING_ATTR_AGG)
        return v if isinstance(v, str) and v in MEASURE_AGGS else None

    def distinct(self) -> bool:
        """ADR-0039: resolving. True when ``@distinct`` is set (legal only with ``@agg: count``)."""
        return self.get_meta_attr(REPORTING_ATTR_DISTINCT) is True

    def of_columns(self) -> list[str]:
        """ADR-0039: resolving. The ``Entity.field`` references in ``@of``: a bare
        string is one column, a list is the tuple form."""
        v = self.get_meta_attr(REPORTING_ATTR_OF)
        if isinstance(v, list):
            return [x for x in v if isinstance(x, str)]
        return [v] if isinstance(v, str) else []

    def segment_name(self) -> str | None:
        """ADR-0039: resolving. Name of a segment declared on the same entity;
        combines with ``@filter`` by AND."""
        return _optional_string(self.get_meta_attr(REPORTING_ATTR_SEGMENT))

    def filter(self) -> dict[str, object] | None:
        """ADR-0039: resolving. The canonical row-scope filter, when one is declared."""
        v = self.get_meta_attr(REPORTING_ATTR_FILTER)
        return v if isinstance(v, dict) else None

    def default_value(self) -> int | None:
        """ADR-0039: resolving, so an inherited measure keeps it. ``@default``: the integer
        this measure reads when it would otherwise be null (rules M7/M8 decide where it is
        legal). ``None`` for anything that is not an integer: ``bool`` is a subclass of
        ``int`` in Python, and ``True`` is not a default."""
        v = self.get_meta_attr(REPORTING_ATTR_DEFAULT)
        return v if isinstance(v, int) and not isinstance(v, bool) else None

    def numerator(self) -> str | None:
        """ADR-0039: resolving. Name of the ``measure.aggregate`` sibling used as the
        numerator (``measure.ratio`` only)."""
        return _optional_string(self.get_meta_attr(REPORTING_ATTR_NUMERATOR))

    def denominator(self) -> str | None:
        """ADR-0039: resolving. Name of the ``measure.aggregate`` sibling used as the
        denominator (``measure.ratio`` only)."""
        return _optional_string(self.get_meta_attr(REPORTING_ATTR_DENOMINATOR))
