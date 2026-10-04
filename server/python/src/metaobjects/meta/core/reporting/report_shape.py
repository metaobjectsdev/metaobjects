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
    report_measure_item_name,
    report_measure_item_owner,
    report_measure_names,
)
from .reporting_constants import (
    AGG_AVG,
    AGG_COUNT,
    AGG_SUM,
    GRAIN_HOUR,
    TIME_GRAINS,
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


def _is_self_or_ancestor(candidate: MetaData | None, entity: MetaData) -> bool:
    """True when ``candidate`` is ``entity`` or an entity it extends (the super chain).
    The loader's own test (``validate_reporting._is_self_or_ancestor``), restated because
    this package cannot import the loader (the loader imports it)."""
    visited: set[int] = set()
    n: MetaData | None = entity
    while n is not None and id(n) not in visited:
        if n is candidate:
            return True
        visited.add(id(n))
        n = n.super_data
    return False


def reporting_member_owner(member: MetaData, from_: MetaObject) -> MetaData:
    """The entity that DECLARES a dimension or measure reached through ``from_``: the
    member's parent, which is ``from_`` itself or an entity ``from_`` extends. A bare
    entity name inside the member (``@of``, ``@via``) resolves in THIS entity's package,
    exactly as the loader's ``validate_reporting`` resolves it (``_pkg_of(ctx.declaring)``),
    never in ``from_``'s package or the report's."""
    return member.parent if member.parent is not None else from_


def resolve_reporting_field_ref(
    ref: str, declaring: MetaData, root: MetaRoot, host: MetaObject | None = None
) -> MetaField | None:
    """Resolve a dimension's or measure's ``Entity.field`` reference to the field node.
    The ONE rule, the same as the loader's (``validate_reporting`` D1 / M1) and as the
    TypeScript ``resolveReportingFieldRef``:

    1. The entity half resolves relative to the package of ``declaring``, the entity that
       declares the member (:func:`reporting_member_owner`).
    2. With ``host`` (a measure, or a dimension without ``@via``: the reference is about
       the ``@from`` entity's own rows) the named entity must be ``host`` or an entity it
       extends, and the field is read from ``host``, so a field ``host`` redeclares wins.
    3. Without ``host`` (a dimension with ``@via``) the field is read from the named entity.

    ``None`` when any step fails.
    """
    # ``Entity.field``; a package qualifier uses ``::``, so the member separator is the LAST dot.
    dot = ref.rfind(CHILD_REF_SEP)
    if dot <= 0:
        return None
    named = resolve_object_ref(root, ref[:dot], _package_of_key(declaring.resolution_key()))
    if not isinstance(named, MetaObject):
        return None
    if host is not None and not _is_self_or_ancestor(named, host):
        return None
    # ADR-0039: resolving fields(), so a field inherited through extends is found.
    member = ref[dot + len(CHILD_REF_SEP):]
    return next((f for f in (host if host is not None else named).fields() if f.name == member), None)


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
    vialess = dim.via() is None
    of = resolve_reporting_field_ref(
        dim.of() or "", reporting_member_owner(dim, from_), root, from_ if vialess else None
    )
    if of is None:
        raise _unresolved(report_name, f"dimension '{item.name}' @of")
    name = report_derived_field_name(item)
    # ADR-0039 resolving: the @of field's effective @required (the attr only; a
    # validator.required child does not count).
    required = vialess and of.get_meta_attr(FIELD_ATTR_REQUIRED) is True
    if dim.is_time():
        # Loader rule R2 guarantees a grain from the closed set; a tree built in code does not.
        grain = item.grain
        if grain is None or grain not in TIME_GRAINS:
            raise _unresolved(report_name, f"time dimension '{item.name}' grain '{grain or ''}'")
        if grain == GRAIN_HOUR:
            return ReportField(
                name, ROLE_DIMENSION, FIELD_SUBTYPE_TIMESTAMP, required, of, dimension=dim, grain=grain
            )
        return ReportField(name, ROLE_DIMENSION, FIELD_SUBTYPE_DATE, required, None, dimension=dim, grain=grain)
    return ReportField(name, ROLE_DIMENSION, of.sub_type, required, of, dimension=dim)


def _measure_field(item: str, report: MetaObject, from_: MetaObject, root: MetaRoot) -> ReportField:
    """One ``@measures`` item, bare (``total``) or dotted (``Sale.total``, loader rule R3).
    The measure is named by the item's last segment and looked up on ``from_``; a qualifier
    resolves in the REPORT's package and must be ``from_`` or an entity ``from_`` extends."""
    report_name = report.name
    name = report_measure_item_name(item)
    qualifier = report_measure_item_owner(item)
    if qualifier is not None:
        owner = resolve_object_ref(root, qualifier, _package_of_key(report.resolution_key()))
        if owner is None or not _is_self_or_ancestor(owner, from_):
            raise _unresolved(report_name, f"measure '{item}' on '{from_.name}'")
    m = _declared_member(from_, TYPE_MEASURE, name, MetaMeasure)
    if not isinstance(m, MetaMeasure):
        raise _unresolved(report_name, f"measure '{item}' on '{from_.name}'")
    if m.is_ratio():
        return ReportField(name, ROLE_MEASURE, FIELD_SUBTYPE_DECIMAL, False, measure=m)
    agg = m.agg()
    if agg == AGG_COUNT:
        return ReportField(name, ROLE_MEASURE, FIELD_SUBTYPE_LONG, True, measure=m)
    cols = m.of_columns()
    of = resolve_reporting_field_ref(cols[0] if cols else "", reporting_member_owner(m, from_), root, from_)
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
        *(_measure_field(item, report, from_, root) for item in report_measure_names(report)),
    )
    return ReportShape(report, from_, tuple(fields))
