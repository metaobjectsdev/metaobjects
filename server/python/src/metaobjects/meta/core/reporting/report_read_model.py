"""A report's READ MODEL (FR-044): a detached object carrying one real ``field.*``
child per derived field (Table B) and a copy of the report's own read-only source.

WHY IT EXISTS

An ``object.report`` declares no fields: its read shape is derived from its
dimensions and measures. A metadata-driven runtime walks an object's field
children in a dozen places (column list, filter and sort resolution, the name
map, every read coercion). Rather than teach each of them what a report is, the
runtime reads a report through this model and sees ordinary fields.

WHY IT IS DETACHED

The model is never added to the root: it has no parent, ``root.children()`` does
not list it, and the canonical serializer, ``fmt``, codegen and every other tree
walker never see it. Nothing in the loaded tree is mutated to build it; in
particular the report's own source node is COPIED, not re-parented
(``add_child`` rewrites the child's ``parent``). The nodes are constructed
directly, not through the loader or the registry, so no vocabulary is added:
every node is an already-registered ``type.subType``.

It keeps the report's name, package and ``object.report`` subtype, so a consumer
holding it can still tell it is a report (no identity, read-only).

Mirrors TS ``core/reporting/report-read-model.ts``. ADR-0039 / Python naming
inversion: ``attr()`` is OWN-ONLY here, so the TS ``attr()`` reads are
``get_meta_attr()`` below.
"""
from __future__ import annotations

from weakref import WeakKeyDictionary

from ....shared.base_types import TYPE_FIELD
from ...meta_root import MetaRoot
from ...persistence.db.db_constants import FIELD_ATTR_DB_COLUMN_TYPE, FIELD_ATTR_LOCAL_TIME
from ...persistence.source.meta_source import MetaSource
from ...persistence.source.source_constants import SOURCE_ATTR_ROLE, SOURCE_ROLE_PRIMARY
from ..field.field_constants import (
    FIELD_ATTR_CURRENCY,
    FIELD_ATTR_FILTERABLE,
    FIELD_ATTR_INT_VALUE_MAP,
    FIELD_ATTR_MAX_LENGTH,
    FIELD_ATTR_OBJECT_REF,
    FIELD_ATTR_PRECISION,
    FIELD_ATTR_REQUIRED,
    FIELD_ATTR_SCALE,
    FIELD_ATTR_STORAGE,
    FIELD_ATTR_VALUES,
)
from ..field.meta_field import MetaField
from ..object.meta_object import MetaObject
from .report_shape import ReportField, report_shape

#: Table B: the type-shaping attrs a derived field carries from its ``type_source``,
#: read with the RESOLVING accessor (ADR-0039) so a value the ``@of`` field inherits
#: through ``extends`` is carried too. ``@dbColumnType`` and ``isArray`` are handled
#: separately below. Nothing else is carried: no ``@column``, ``@required``,
#: ``@default``, validators or views.
_CARRIED_ATTRS: tuple[str, ...] = (
    FIELD_ATTR_CURRENCY,
    FIELD_ATTR_VALUES,
    FIELD_ATTR_INT_VALUE_MAP,
    FIELD_ATTR_MAX_LENGTH,
    FIELD_ATTR_PRECISION,
    FIELD_ATTR_SCALE,
    FIELD_ATTR_LOCAL_TIME,
    FIELD_ATTR_OBJECT_REF,
    FIELD_ATTR_STORAGE,
)

#: Read models cached per report node (identity-keyed; nodes define no ``__eq__``).
_READ_MODELS: "WeakKeyDictionary[MetaObject, MetaObject]" = WeakKeyDictionary()


def _derived_field(f: ReportField) -> MetaField:
    field = MetaField(TYPE_FIELD, f.sub_type, f.name)
    # From the derived shape, never from the type source: a ``min`` of a required column
    # is still nullable, and a dimension reached by ``@via`` is nullable.
    field.set_attr(FIELD_ATTR_REQUIRED, f.required)
    src = f.type_source
    if src is not None:
        for name in _CARRIED_ATTRS:
            value = src.get_meta_attr(name)
            if value is not None:
                field.set_attr(name, value)
        # ADR-0039: own — ``@dbColumnType`` is the one deliberately own-only attr (a
        # physical column-type override is never inherited), and every consumer reads
        # it with ``attr()`` (own). So it is read own from the type source and set OWN
        # here: the derived field carries exactly what the ``@of`` field itself
        # declares, and nothing its supers declare.
        db_column_type = src.attr(FIELD_ATTR_DB_COLUMN_TYPE)
        if db_column_type is not None:
            field.set_attr(FIELD_ATTR_DB_COLUMN_TYPE, db_column_type)
        # ``is_array`` is a native flag, not an attr; ``resolved_is_array()`` is its resolving read.
        if src.resolved_is_array():
            field.is_array = True
    # Table C (Plan 3): a report author has no node to put @filterable on, so every
    # derived field that has a filter band is filterable. Set on this detached model
    # only; no vocabulary is added and the declared tree is not touched. Imported here
    # because the loader's validation passes import this package.
    from ....loader.validation_passes import ops_for_field

    if ops_for_field(field):
        field.set_attr(FIELD_ATTR_FILTERABLE, True)
    return field


def report_read_source(report: MetaObject) -> MetaSource | None:
    """The source a report is READ from: its own read-only source with ``@role: primary``,
    else its first own read-only source. ``None`` when it declares none (Table A: not
    lowered, not served).

    This is the rule that NAMES the lowered view (``viewName`` / ``projectionViewSource``
    in codegen-ts's ``projection/extract-view-spec.ts``). It is restated here because
    this package cannot depend on the TS codegen; the two must stay the same rule, or
    the runtime reads a relation the lowering did not create.

    What the loader permits: a report may declare several read-only sources (a
    ``@role: replica`` view beside its primary view loads clean, in either order);
    ``@role`` defaults to ``primary``; a report whose sources include no primary is
    ``ERR_SOURCE_NO_PRIMARY``; a writable source on a report is refused. So for every
    model that loads, the primary branch fires. The first-read-only fallback covers a
    tree built in code and keeps this rule identical to the lowering's.
    """
    # ADR-0039: own — source classification reads the sources the report declares
    # ITSELF, exactly as the lowering's ``viewName`` does.
    read_only = [c for c in report.own_children() if isinstance(c, MetaSource) and c.is_read_only()]
    return next((s for s in read_only if s.role() == SOURCE_ROLE_PRIMARY), read_only[0] if read_only else None)


def _copy_source(source: MetaSource) -> MetaSource:
    """A detached copy of a source node: same ``type.subType``, name and effective attrs,
    and nothing else (attrs only — the loaded node is never re-parented).

    The copy is the model's ONLY source, and it is pinned to ``@role: primary``: the
    runtime resolves an object's table through ``primary_rdb_source``, which considers
    primary sources only, so this is what makes the read land on the selected source's
    physical name rather than on a default table name nobody declared."""
    copy = MetaSource(source.type, source.sub_type, source.name)
    # ADR-0039: resolving — the copy carries the source's effective configuration
    # (@kind, the physical-name alias, @schema, @unmanaged, @sql).
    for name, value in source.attrs().items():
        copy.set_attr(name, value)
    copy.set_attr(SOURCE_ATTR_ROLE, SOURCE_ROLE_PRIMARY)
    return copy


def report_read_model(report: MetaObject, root: MetaRoot) -> MetaObject:
    """The read model of an ``object.report``: one field per Table B row, in Table B
    order, plus a copy of the source the report is read from (see
    :func:`report_read_source`) when it declares one (Table A). A sourceless report
    yields a model with no source: it has a shape and no view, and the caller decides
    what that means (the runtime refuses to serve it).

    Cached per report node (identity-keyed); the model is frozen. Raises what
    :func:`report_shape` raises when a reference does not resolve.
    """
    cached = _READ_MODELS.get(report)
    if cached is not None:
        return cached

    shape = report_shape(report, root)
    model = MetaObject(report.type, report.sub_type, report.name)
    model.package = report.package
    model.file_default_package = report.file_default_package
    for f in shape.fields:
        model.add_child(_derived_field(f))

    source = report_read_source(report)
    if source is not None:
        model.add_child(_copy_source(source))

    model.freeze()
    _READ_MODELS[report] = model
    return model


__all__ = ["report_read_model", "report_read_source"]
