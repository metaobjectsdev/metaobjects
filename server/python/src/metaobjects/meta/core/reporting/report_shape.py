"""Table B of the FR-044 Plan 2 contract: a report's derived fields. The single
Python definition; every port has a rule-for-rule copy, gated by
``fixtures/persistence-conformance/report-shapes.json``.

ADR-0039: every read is RESOLVING. Python naming inversion: ``attr()`` is
OWN-ONLY here, so the TypeScript reference's ``attr()`` is ``get_meta_attr()``
below, and ``fields()`` / ``children()`` are the resolving member accessors.
Mirrors TS ``core/reporting/report-shape.ts``.
"""
from __future__ import annotations

from dataclasses import dataclass

from ....naming_refs import CHILD_REF_SEP, resolve_object_ref
from ....shared.separators import PACKAGE_SEP
from ...meta_data import MetaData
from ...meta_root import MetaRoot
from ..field.field_constants import (
    FIELD_ATTR_REQUIRED,
    FIELD_SUBTYPE_CURRENCY,
    FIELD_SUBTYPE_DATE,
    FIELD_SUBTYPE_DECIMAL,
    FIELD_SUBTYPE_DOUBLE,
    FIELD_SUBTYPE_FLOAT,
    FIELD_SUBTYPE_INT,
    FIELD_SUBTYPE_LONG,
    FIELD_SUBTYPE_TIMESTAMP,
)
from ..field.meta_field import MetaField
from ..object.meta_object import MetaObject
from .meta_dimension import MetaDimension
from .meta_measure import MetaMeasure
from .report_accessors import (
    ReportDimensionItem,
    report_derived_field_name,
    report_dimension_items,
    report_from,
    report_measure_names,
)
from .reporting_constants import (
    AGG_AVG,
    AGG_COUNT,
    AGG_SUM,
    GRAIN_HOUR,
    TYPE_DIMENSION,
    TYPE_MEASURE,
)

ROLE_DIMENSION = "dimension"
ROLE_MEASURE = "measure"

_SUM_LONG = frozenset({FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG})
_FLOATING = frozenset({FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT})


@dataclass(frozen=True)
class ReportField:
    name: str
    role: str  # ROLE_DIMENSION | ROLE_MEASURE
    #: A field subtype name (``FIELD_SUBTYPE_*``).
    sub_type: str
    required: bool
    #: The ``@of`` field whose type-shaping attrs this field carries (Table B).
    type_source: MetaField | None = None
    dimension: MetaDimension | None = None
    grain: str | None = None
    measure: MetaMeasure | None = None


@dataclass(frozen=True)
class ReportShape:
    report: MetaObject
    from_: MetaObject
    fields: tuple[ReportField, ...]


def _package_of_key(key: str) -> str:
    """Effective package of a node, taken from its resolution key (``<pkg>::<Name>``)."""
    i = key.rfind(PACKAGE_SEP)
    return key[:i] if i >= 0 else ""


def resolve_reporting_field_ref(ref: str, owner: MetaObject, root: MetaRoot) -> MetaField | None:
    """Resolve a dimension's or measure's ``Entity.field`` reference to the field node."""
    # ``Entity.field``; a package qualifier uses ``::``, so the member separator is the LAST dot.
    dot = ref.rfind(CHILD_REF_SEP)
    if dot <= 0:
        return None
    entity = resolve_object_ref(root, ref[:dot], _package_of_key(owner.resolution_key()))
    if not isinstance(entity, MetaObject):
        return None
    # ADR-0039: resolving fields(), so a field inherited through extends is found.
    member = ref[dot + len(CHILD_REF_SEP):]
    return next((f for f in entity.fields() if f.name == member), None)


def _unresolved(report_name: str, what: str) -> ValueError:
    return ValueError(f"report '{report_name}': {what} does not resolve.")


def _declared_member(from_: MetaObject, type_: str, name: str, cls: type[MetaData]) -> MetaData | None:
    # ADR-0039: resolving children(), so a member declared on an abstract base is found.
    return next(
        (c for c in from_.children() if c.type == type_ and c.name == name and isinstance(c, cls)),
        None,
    )


def _dimension_field(
    item: ReportDimensionItem, from_: MetaObject, root: MetaRoot, report_name: str
) -> ReportField:
    dim = _declared_member(from_, TYPE_DIMENSION, item.name, MetaDimension)
    if not isinstance(dim, MetaDimension):
        raise _unresolved(report_name, f"dimension '{item.name}' on '{from_.name}'")
    of = resolve_reporting_field_ref(dim.of() or "", from_, root)
    if of is None:
        raise _unresolved(report_name, f"dimension '{item.name}' @of")
    name = report_derived_field_name(item)
    # ADR-0039 resolving: the @of field's effective @required (the attr only; a
    # validator.required child does not count).
    required = dim.via() is None and of.get_meta_attr(FIELD_ATTR_REQUIRED) is True
    if dim.is_time():
        grain = item.grain
        if grain == GRAIN_HOUR:
            return ReportField(
                name, ROLE_DIMENSION, FIELD_SUBTYPE_TIMESTAMP, required, of, dimension=dim, grain=grain
            )
        return ReportField(name, ROLE_DIMENSION, FIELD_SUBTYPE_DATE, required, None, dimension=dim, grain=grain)
    return ReportField(name, ROLE_DIMENSION, of.sub_type, required, of, dimension=dim)


def _measure_field(name: str, from_: MetaObject, root: MetaRoot, report_name: str) -> ReportField:
    m = _declared_member(from_, TYPE_MEASURE, name, MetaMeasure)
    if not isinstance(m, MetaMeasure):
        raise _unresolved(report_name, f"measure '{name}' on '{from_.name}'")
    if m.is_ratio():
        return ReportField(name, ROLE_MEASURE, FIELD_SUBTYPE_DECIMAL, False, measure=m)
    agg = m.agg()
    if agg == AGG_COUNT:
        return ReportField(name, ROLE_MEASURE, FIELD_SUBTYPE_LONG, True, measure=m)
    cols = m.of_columns()
    of = resolve_reporting_field_ref(cols[0] if cols else "", from_, root)
    if of is None:
        raise _unresolved(report_name, f"measure '{name}' @of")
    src = of.sub_type
    if agg == AGG_SUM:
        if src == FIELD_SUBTYPE_CURRENCY:
            return ReportField(name, ROLE_MEASURE, FIELD_SUBTYPE_CURRENCY, False, of, measure=m)
        sub_type = (
            FIELD_SUBTYPE_LONG
            if src in _SUM_LONG
            else FIELD_SUBTYPE_DOUBLE
            if src in _FLOATING
            else FIELD_SUBTYPE_DECIMAL
        )
        return ReportField(name, ROLE_MEASURE, sub_type, False, measure=m)
    if agg == AGG_AVG:
        sub_type = FIELD_SUBTYPE_DOUBLE if src in _FLOATING else FIELD_SUBTYPE_DECIMAL
        return ReportField(name, ROLE_MEASURE, sub_type, False, measure=m)
    # min / max keep the source field's type.
    return ReportField(name, ROLE_MEASURE, src, False, of, measure=m)


def report_shape(report: MetaObject, root: MetaRoot) -> ReportShape:
    """Table B. Raises a ``ValueError`` naming the report when a reference does not
    resolve (a report that passed ``validate_reporting`` always resolves)."""
    from_name = report_from(report)
    if from_name is None:
        raise _unresolved(report.name, "@from")
    from_ = resolve_object_ref(root, from_name, _package_of_key(report.resolution_key()))
    if not isinstance(from_, MetaObject):
        raise _unresolved(report.name, f"@from '{from_name}'")
    fields = (
        *(_dimension_field(item, from_, root, report.name) for item in report_dimension_items(report)),
        *(_measure_field(n, from_, root, report.name) for n in report_measure_names(report)),
    )
    return ReportShape(report, from_, tuple(fields))
