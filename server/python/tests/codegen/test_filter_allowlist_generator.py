"""Tests for the FR-009 FilterAllowlist generator.

One ``<entity_snake>_filter_allowlist.py`` per writable entity
(``source.rdb @kind="table"``); emits a per-entity
``<ENTITY>_FILTER_FIELDS`` frozenset + ``<ENTITY>_FILTER_OPS_BY_FIELD``
dict, gated by the cross-port operator/subtype matrix.

Mirror of ``SpringFilterAllowlistGenerator`` (Java) +
``KotlinFilterAllowlistGenerator`` (Kotlin).
"""
import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes

from metaobjects.codegen.generators.filter_allowlist_generator import (
    render_filter_allowlist,
)
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.persistence.source.meta_source import MetaSource
from metaobjects.meta.persistence.source.source_constants import (
    SOURCE_ATTR_KIND,
    SOURCE_KIND_VIEW,
    SOURCE_SUBTYPE_RDB,
)
from metaobjects.shared.base_types import TYPE_FIELD, TYPE_OBJECT, TYPE_SOURCE


def _entity(
    name: str,
    fields: list[MetaField],
    *,
    source_kind: str | None = "table",
    package: str | None = None,
) -> MetaObject:
    o = MetaObject(TYPE_OBJECT, "entity", name)
    o.package = package
    if source_kind is not None:
        src = MetaSource(TYPE_SOURCE, SOURCE_SUBTYPE_RDB, "")
        if source_kind != "table":
            src.set_attr(SOURCE_ATTR_KIND, source_kind, sub_type="string")
        o.add_child(src)
    for f in fields:
        o.add_child(f)
    return o


def _f(name: str, sub: str, *, filterable: bool = False) -> MetaField:
    f = MetaField(TYPE_FIELD, sub, name)
    if filterable:
        f.set_attr(fc.FIELD_ATTR_FILTERABLE, True)
    return f


def test_empty_allowlist_when_no_filterable_fields() -> None:
    """Entities without any ``@filterable: true`` field still get a file emitted
    so the router can unconditionally delegate. The constants are empty
    frozenset / empty dict."""
    entity = _entity(
        "Author",
        [
            _f("id", fc.FIELD_SUBTYPE_INT),
            _f("name", fc.FIELD_SUBTYPE_STRING),
        ],
        package="acme::blog",
    )
    out = render_filter_allowlist(entity)
    assert out is not None
    # Empty frozenset literal — `frozenset()` not `frozenset({})` (the latter
    # is invalid Python with `{}` parsing as an empty dict).
    assert "AUTHOR_FILTER_FIELDS: frozenset[str] = frozenset()" in out
    # Empty dict literal for the per-field op map.
    assert "AUTHOR_FILTER_OPS_BY_FIELD: dict[str, frozenset[str]] = {}" in out
    # No field names leak into the file.
    assert '"name"' not in out
    assert '"id"' not in out


def test_per_subtype_operator_gating() -> None:
    """Each subtype gets its FR-009-spec'd operator vocabulary. Verifies the
    cross-port matrix:

    * string  → eq, ne, in, like, isNull
    * int / timestamp / currency → eq, ne, gt, gte, lt, lte, in, isNull
    * boolean → eq, isNull
    """
    entity = _entity(
        "Mixed",
        [
            _f("name", fc.FIELD_SUBTYPE_STRING, filterable=True),
            _f("createdAt", fc.FIELD_SUBTYPE_TIMESTAMP, filterable=True),
            _f("active", fc.FIELD_SUBTYPE_BOOLEAN, filterable=True),
            _f("price", fc.FIELD_SUBTYPE_CURRENCY, filterable=True),
            _f("notFilterable", fc.FIELD_SUBTYPE_STRING),  # no @filterable
        ],
        package="acme::shop",
    )
    out = render_filter_allowlist(entity)
    assert out is not None

    # FIELDS contains every filterable field, skips the un-flagged one.
    assert '"name"' in out
    assert '"createdAt"' in out
    assert '"active"' in out
    assert '"price"' in out
    assert '"notFilterable"' not in out

    # Per-subtype operator gating — exact set, in spec order.
    assert (
        '"name": frozenset({"eq", "ne", "in", "like", "isNull"})'
        in out
    )
    assert (
        '"createdAt": frozenset({"eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"})'
        in out
    )
    assert '"active": frozenset({"eq", "isNull"})' in out
    assert (
        '"price": frozenset({"eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"})'
        in out
    )


def test_view_kind_gets_no_allowlist() -> None:
    """Same gate as the router generator: read-only kinds skip allowlist
    emission. Returning ``None`` keeps the two generators in lock-step so
    the router never imports an allowlist module that wasn't emitted."""
    view = _entity(
        "AuthorView",
        [_f("name", fc.FIELD_SUBTYPE_STRING, filterable=True)],
        source_kind=SOURCE_KIND_VIEW,
        package="acme::blog",
    )
    assert render_filter_allowlist(view) is None


def test_object_fields_skipped() -> None:
    """``field.object`` has no SQL column surface — even with ``@filterable:
    true`` it must not appear in the allowlist."""
    entity = _entity(
        "WithObject",
        [
            _f("name", fc.FIELD_SUBTYPE_STRING, filterable=True),
            _f("nested", fc.FIELD_SUBTYPE_OBJECT, filterable=True),
        ],
        package="acme::blog",
    )
    out = render_filter_allowlist(entity)
    assert out is not None
    assert '"name"' in out
    assert '"nested"' not in out
