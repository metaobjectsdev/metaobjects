"""Reporting concern constants (FR-044) — subtypes, attr keys and the closed sets
the registry enforces through ``allowed_values``.

``dimension``, ``measure`` and ``segment`` are children of ``object.entity`` only
(never root-level), and ``object.report`` (see object_constants.py) references
them by name. The type-name constants live in shared/base_types.py beside every
other base type and are re-exported here so a reporting consumer has one import
site. Mirrors TS ``core/reporting/reporting-constants.ts``.
"""
from __future__ import annotations

import re

from ....shared.base_types import TYPE_DIMENSION, TYPE_MEASURE, TYPE_SEGMENT

__all__ = [
    "TYPE_DIMENSION",
    "TYPE_MEASURE",
    "TYPE_SEGMENT",
]

# ---------------------------------------------------------------------------
# Subtypes
# ---------------------------------------------------------------------------

#: Groups by a column value as-is (no grain, no truncation).
DIMENSION_SUBTYPE_ATTRIBUTE = "attribute"
#: Groups by a date/timestamp column truncated to a grain.
DIMENSION_SUBTYPE_TIME = "time"
DIMENSION_SUBTYPES: tuple[str, ...] = (DIMENSION_SUBTYPE_ATTRIBUTE, DIMENSION_SUBTYPE_TIME)

#: One aggregate over the declaring entity's own rows.
MEASURE_SUBTYPE_AGGREGATE = "aggregate"
#: A quotient of two ``measure.aggregate`` siblings, ``numerator / NULLIF(denominator, 0)``.
#: ``measure.derived`` is deliberately NOT registered: it waits for FR-037 R5.
MEASURE_SUBTYPE_RATIO = "ratio"
MEASURE_SUBTYPES: tuple[str, ...] = (MEASURE_SUBTYPE_AGGREGATE, MEASURE_SUBTYPE_RATIO)

#: A named, reusable row filter. The only concrete segment subtype.
SEGMENT_SUBTYPE_FILTER = "filter"
SEGMENT_SUBTYPES: tuple[str, ...] = (SEGMENT_SUBTYPE_FILTER,)

# ---------------------------------------------------------------------------
# Attrs (on dimension / measure / segment nodes)
# ---------------------------------------------------------------------------

#: Dotted ``Entity.field`` reference(s) naming the grouped / aggregated column(s).
REPORTING_ATTR_OF = "of"
#: Optional dotted to-one relationship path from the owning entity to the ``@of`` entity.
REPORTING_ATTR_VIA = "via"
#: The grains a ``dimension.time`` supports.
REPORTING_ATTR_GRAINS = "grains"
#: The aggregate function of a ``measure.aggregate``.
REPORTING_ATTR_AGG = "agg"
#: Count distinct values (legal only with ``@agg: count``).
REPORTING_ATTR_DISTINCT = "distinct"
#: Row scope (an attr.filter) on a ``measure.aggregate`` or ``segment.filter``.
REPORTING_ATTR_FILTER = "filter"
#: Name of a segment declared on the same entity.
REPORTING_ATTR_SEGMENT = "segment"
#: ``measure.ratio`` operand names.
REPORTING_ATTR_NUMERATOR = "numerator"
REPORTING_ATTR_DENOMINATOR = "denominator"

# ---------------------------------------------------------------------------
# Closed sets — mirrored by ``allowedValues`` in spec/metamodel/reporting.json.
# Order is part of the contract (it is the order the registry manifest records).
# ---------------------------------------------------------------------------

#: Weeks start on Monday (ISO-8601) in every lowering.
GRAIN_HOUR = "hour"
GRAIN_DAY = "day"
GRAIN_WEEK = "week"
GRAIN_MONTH = "month"
GRAIN_QUARTER = "quarter"
GRAIN_YEAR = "year"
TIME_GRAINS: tuple[str, ...] = (
    GRAIN_HOUR,
    GRAIN_DAY,
    GRAIN_WEEK,
    GRAIN_MONTH,
    GRAIN_QUARTER,
    GRAIN_YEAR,
)

AGG_COUNT = "count"
AGG_SUM = "sum"
AGG_AVG = "avg"
AGG_MIN = "min"
AGG_MAX = "max"
MEASURE_AGGS: tuple[str, ...] = (AGG_COUNT, AGG_SUM, AGG_AVG, AGG_MIN, AGG_MAX)

#: Separator in an ``object.report`` ``@dimensions`` item: ``name`` or ``name:grain``.
REPORT_DIMENSION_GRAIN_SEPARATOR = ":"

# ---------------------------------------------------------------------------
# Relative-date filter values (spec §4 R4; rules F1/F2)
# ---------------------------------------------------------------------------

#: The single key of a relative-date filter value: ``{ "now": "<ISO-8601 duration>" }``
#: means "the current time plus that duration", evaluated when the view is queried.
#: Legal only in the ``@filter`` of a ``segment``, ``measure.aggregate`` or ``object.report``.
FILTER_RELATIVE_NOW = "now"

#: A signed ISO-8601 duration (``-P7D``, ``P1Y2M``, ``-PT12H``). The lookaheads refuse
#: the degenerate ``P`` and ``PT`` forms (a designator with no component). The pattern
#: is the rule table's verbatim; ``\Z`` stands in for JS ``$`` (Python ``$`` would also
#: match before a trailing newline).
ISO_DURATION_RE = re.compile(
    r"^[+-]?P(?!\Z)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?\Z",
    re.ASCII,
)
