"""Free accessors over an ``object.report`` node (FR-044). Used by the Plan 2
lowering and by the loader's report validation, so the ``name:grain`` parse and
the derived-field-name rule have exactly one definition.

ADR-0039: every read is RESOLVING (``get_meta_attr``) — Python naming inversion,
``attr()`` is OWN-ONLY here. Mirrors TS ``core/reporting/report-accessors.ts``.
"""
from __future__ import annotations

from dataclasses import dataclass

from ...meta_data import MetaData
from ..object.object_constants import (
    OBJECT_REPORT_ATTR_DIMENSIONS,
    OBJECT_REPORT_ATTR_FROM,
    OBJECT_REPORT_ATTR_MEASURES,
)
from .reporting_constants import REPORT_DIMENSION_GRAIN_SEPARATOR


@dataclass(frozen=True)
class ReportDimensionItem:
    """One ``@dimensions`` item: ``name``, or ``name:grain`` (``grain`` is ``None`` when absent)."""

    name: str
    grain: str | None = None


def _string_list(v: object) -> list[str]:
    if isinstance(v, list):
        return [x for x in v if isinstance(x, str)]
    return [v] if isinstance(v, str) else []


def report_from(obj: MetaData) -> str | None:
    """ADR-0039: resolving. The ``@from`` entity name of a report."""
    v = obj.get_meta_attr(OBJECT_REPORT_ATTR_FROM)
    return v if isinstance(v, str) else None


def report_dimension_items(obj: MetaData) -> list[ReportDimensionItem]:
    """ADR-0039: resolving. The ``@dimensions`` items, each ``name`` or ``name:grain``
    (split at the FIRST separator)."""
    out: list[ReportDimensionItem] = []
    for raw in _string_list(obj.get_meta_attr(OBJECT_REPORT_ATTR_DIMENSIONS)):
        i = raw.find(REPORT_DIMENSION_GRAIN_SEPARATOR)
        if i == -1:
            out.append(ReportDimensionItem(raw))
        else:
            out.append(ReportDimensionItem(raw[:i], raw[i + len(REPORT_DIMENSION_GRAIN_SEPARATOR):]))
    return out


def report_measure_names(obj: MetaData) -> list[str]:
    """ADR-0039: resolving. The ``@measures`` names."""
    return _string_list(obj.get_meta_attr(OBJECT_REPORT_ATTR_MEASURES))


def report_derived_field_name(item: ReportDimensionItem) -> str:
    """The derived report field for a dimension item: ``name`` (attribute) or
    ``name`` + Capitalized(grain) (time), e.g. ``purchasedAt:day`` -> ``purchasedAtDay``."""
    if item.grain is None or item.grain == "":
        return item.name
    return item.name + item.grain[0].upper() + item.grain[1:]
