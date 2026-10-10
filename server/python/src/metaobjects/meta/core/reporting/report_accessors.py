"""Free accessors over an ``object.report`` node (FR-044). Used by the Plan 2
lowering and by the loader's report validation, so the ``name:grain`` parse and
the derived-field-name rule have exactly one definition.

ADR-0039: every read is RESOLVING (``get_meta_attr``) — Python naming inversion,
``attr()`` is OWN-ONLY here. Mirrors TS ``core/reporting/report-accessors.ts``.
"""
from __future__ import annotations

from dataclasses import dataclass

from ....naming_refs import CHILD_REF_SEP
from ...meta_data import MetaData
from ..object.object_constants import (
    OBJECT_REPORT_ATTR_DIMENSIONS,
    OBJECT_REPORT_ATTR_FROM,
    OBJECT_REPORT_ATTR_MEASURES,
    OBJECT_REPORT_ATTR_SPINE,
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


def report_spine(obj: MetaData) -> str | None:
    """ADR-0039: resolving. ``@spine``: the to-one path to the entity whose rows supply
    the report's rows (``None`` when absent or empty)."""
    v = obj.get_meta_attr(OBJECT_REPORT_ATTR_SPINE)
    return v if isinstance(v, str) and v != "" else None


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
    """ADR-0039: resolving. The ``@measures`` items AS WRITTEN: each a bare measure
    ``name``, or a dotted ``Entity.name`` (loader rule R3). Use
    :func:`report_measure_item_name` for the measure name."""
    return _string_list(obj.get_meta_attr(OBJECT_REPORT_ATTR_MEASURES))


def report_measure_item_name(item: str) -> str:
    """The measure a ``@measures`` item names: the segment after its LAST ``.``
    (``total``, ``Sale.total`` and ``acme::shop::Sale.total`` all name ``total``). It is
    also the derived report field's name. The part before that ``.``, when present, is an
    entity qualifier (:func:`report_measure_item_owner`)."""
    dot = item.rfind(CHILD_REF_SEP)
    return item if dot == -1 else item[dot + len(CHILD_REF_SEP):]


def report_measure_item_owner(item: str) -> str | None:
    """The entity qualifier of a dotted ``@measures`` item (``Sale`` in ``Sale.total``),
    or ``None`` for a bare item. Loader rule R3: it names ``@from`` or an entity ``@from``
    extends."""
    dot = item.rfind(CHILD_REF_SEP)
    return None if dot == -1 else item[:dot]


def report_derived_field_name(item: ReportDimensionItem) -> str:
    """The derived report field for a dimension item: ``name`` (attribute) or
    ``name`` + Capitalized(grain) (time), e.g. ``purchasedAt:day`` -> ``purchasedAtDay``."""
    if item.grain is None or item.grain == "":
        return item.name
    return item.name + item.grain[0].upper() + item.grain[1:]
