"""Table B of the FR-044 Plan 2 contract: a report's derived fields. The single
Python definition; every port has a rule-for-rule copy, gated by
``fixtures/persistence-conformance/report-shapes.json``. ``required`` follows Table C of
docs/superpowers/plans/2026-10-09-fr-044-zero-rows-and-measure-defaults.md, which amends
Table B for a report with ``@spine`` and a measure with ``@default``.

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
from ..identity.identity_constants import IDENTITY_ATTR_FIELDS
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
    report_spine,
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
    named = _resolve_reporting_field_ref_named(ref, declaring, root, host)
    return None if named is None else named[1]


def _resolve_reporting_field_ref_named(
    ref: str, declaring: MetaData, root: MetaRoot, host: MetaObject | None = None
) -> tuple[MetaObject, MetaField] | None:
    """:func:`resolve_reporting_field_ref`, also returning the entity the reference's
    entity half NAMES (which, with ``host``, may be an ancestor of the entity the field is
    read from). Table C reads that entity's primary identity."""
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
    field = next((f for f in (host if host is not None else named).fields() if f.name == member), None)
    return None if field is None else (named, field)


def reporting_via_hops(via: str, declaring: MetaData, from_: MetaObject, root: MetaRoot) -> list[str] | None:
    """The hop names of a dimension's ``@via`` (``Owner.hop[.hop...]``), the owner resolving
    in the package of ``declaring`` and required to be ``from_`` or an entity it extends,
    as the loader's walk requires (TS ``reportingViaHops``). ``None`` when the path is
    malformed or its owner does not resolve so."""
    # The owner ends at the first ``.`` after the last ``::`` (a package qualifier has no ``.``).
    last_sep = via.rfind(PACKAGE_SEP)
    seg_start = 0 if last_sep == -1 else last_sep + len(PACKAGE_SEP)
    dot = via.find(CHILD_REF_SEP, seg_start)
    if dot <= seg_start:
        return None
    hops = via[dot + len(CHILD_REF_SEP):].split(CHILD_REF_SEP)
    if any(h == "" for h in hops):
        return None
    owner = resolve_object_ref(root, via[:dot], _package_of_key(declaring.resolution_key()))
    if owner is None or not _is_self_or_ancestor(owner, from_):
        return None
    return hops


def _unresolved(report_name: str, what: str) -> ValueError:
    return ValueError(f"report '{report_name}': {what} does not resolve.")


def report_spine_hops(report: MetaObject, from_: MetaObject, root: MetaRoot) -> list[str] | None:
    """The hop names of a report's ``@spine`` (``Owner.hop[.hop...]``), read as
    :func:`reporting_via_hops` reads a ``@via``, the owner resolving in the REPORT's package
    (loader rule R8). ``None`` when the report declares no ``@spine``. Raises a
    ``ValueError`` naming the report when a declared ``@spine`` does not resolve (a report
    that passed ``validate_reporting`` always resolves): reading it as "no spine" would
    claim a column non-null that a spine row with no facts leaves null."""
    spine = report_spine(report)
    if spine is None:
        return None
    hops = reporting_via_hops(spine, report, from_, root)
    if hops is None:
        raise _unresolved(report.name, f"@spine '{spine}'")
    return hops


def _is_primary_key_field(entity: MetaObject, field: MetaField) -> bool:
    """True when ``field`` is one of the ``@fields`` of ``entity``'s ``identity.primary``."""
    # ADR-0039: resolving — an identity.primary (and its @fields) inherited from an
    # abstract base counts (primary_identity() reads children(); get_meta_attr resolves).
    pk = entity.primary_identity()
    if pk is None:
        return False
    raw = pk.get_meta_attr(IDENTITY_ATTR_FIELDS)
    if isinstance(raw, list):
        names = [str(v).strip() for v in raw]
    elif isinstance(raw, str):
        names = [s.strip() for s in raw.split(",") if s.strip()]
    else:
        names = []
    return field.name in names


def _declared_member(from_: MetaObject, type_: str, name: str, cls: type[MetaData]) -> MetaData | None:
    # ADR-0039: resolving children(), so a member declared on an abstract base is found.
    return next(
        (c for c in from_.children() if c.type == type_ and c.name == name and isinstance(c, cls)),
        None,
    )


def _dimension_required(
    dim: MetaDimension,
    named: MetaObject,
    of: MetaField,
    from_: MetaObject,
    root: MetaRoot,
    spine: list[str] | None,
    report_name: str,
) -> bool:
    """Table C (``required`` of a dimension). Without ``@spine``: only a dimension with no
    ``@via`` over an ``@of`` field whose effective ``@required`` is true. With ``@spine``:
    only a dimension whose ``@via`` hops equal the spine's (a column of the spine entity
    itself, whose rows are the report's rows) over an ``@of`` field that is ``@required`` or
    a primary-key column of the entity ``@of`` names. A dimension beyond the spine is
    reached by a LEFT OUTER join."""
    via = dim.via()
    # ADR-0039 resolving: the @of field's effective @required (the attr only; a
    # validator.required child does not count).
    of_required = of.get_meta_attr(FIELD_ATTR_REQUIRED) is True
    if spine is None:
        return via is None and of_required
    if via is None:
        return False  # a column of @from: null in a spine row with no facts
    hops = reporting_via_hops(via, reporting_member_owner(dim, from_), from_, root)
    if hops is None:
        raise _unresolved(report_name, f"dimension '{dim.name}' @via '{via}'")
    return hops == spine and (of_required or _is_primary_key_field(named, of))


def _dimension_field(
    item: ReportDimensionItem,
    from_: MetaObject,
    root: MetaRoot,
    report_name: str,
    spine: list[str] | None,
) -> ReportField:
    dim = _declared_member(from_, TYPE_DIMENSION, item.name, MetaDimension)
    if not isinstance(dim, MetaDimension):
        raise _unresolved(report_name, f"dimension '{item.name}' on '{from_.name}'")
    vialess = dim.via() is None
    ref = _resolve_reporting_field_ref_named(
        dim.of() or "", reporting_member_owner(dim, from_), root, from_ if vialess else None
    )
    if ref is None:
        raise _unresolved(report_name, f"dimension '{item.name}' @of")
    named, of = ref
    name = report_derived_field_name(item)
    required = _dimension_required(dim, named, of, from_, root, spine, report_name)
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
    # Table C: a count is never null; any other measure is not null when it has a @default.
    required = (not m.is_ratio() and m.agg() == AGG_COUNT) or m.default_value() is not None
    if m.is_ratio():
        return ReportField(name, ROLE_MEASURE, FIELD_SUBTYPE_DECIMAL, required, measure=m)
    agg = m.agg()
    if agg == AGG_COUNT:
        return ReportField(name, ROLE_MEASURE, FIELD_SUBTYPE_LONG, required, measure=m)
    cols = m.of_columns()
    of = resolve_reporting_field_ref(cols[0] if cols else "", reporting_member_owner(m, from_), root, from_)
    if of is None:
        raise _unresolved(report_name, f"measure '{name}' @of")
    src = of.sub_type
    if agg == AGG_SUM:
        if src == FIELD_SUBTYPE_CURRENCY:
            return ReportField(name, ROLE_MEASURE, FIELD_SUBTYPE_CURRENCY, required, of, measure=m)
        sub_type = (
            FIELD_SUBTYPE_LONG
            if src in _SUM_LONG
            else FIELD_SUBTYPE_DOUBLE
            if src in _FLOATING
            else FIELD_SUBTYPE_DECIMAL
        )
        return ReportField(name, ROLE_MEASURE, sub_type, required, measure=m)
    if agg == AGG_AVG:
        sub_type = FIELD_SUBTYPE_DOUBLE if src in _FLOATING else FIELD_SUBTYPE_DECIMAL
        return ReportField(name, ROLE_MEASURE, sub_type, required, measure=m)
    # min / max keep the source field's type.
    return ReportField(name, ROLE_MEASURE, src, required, of, measure=m)


def report_shape(report: MetaObject, root: MetaRoot) -> ReportShape:
    """Table B, with Table C's ``required``. Raises a ``ValueError`` naming the report when
    a reference does not resolve (a report that passed ``validate_reporting`` always
    resolves)."""
    from_name = report_from(report)
    if from_name is None:
        raise _unresolved(report.name, "@from")
    from_ = resolve_object_ref(root, from_name, _package_of_key(report.resolution_key()))
    if not isinstance(from_, MetaObject):
        raise _unresolved(report.name, f"@from '{from_name}'")
    spine = report_spine_hops(report, from_, root)
    fields = (
        *(_dimension_field(item, from_, root, report.name, spine) for item in report_dimension_items(report)),
        *(_measure_field(item, report, from_, root) for item in report_measure_names(report)),
    )
    return ReportShape(report, from_, tuple(fields))
