"""Unit tests for the dataGrid @filter field/op validation pass (Task P4.3)."""
from __future__ import annotations

from metaobjects.core_types import core_provider
from metaobjects.errors import ErrorCode, MetaError
from metaobjects.loader.validation_passes import ops_for_subtype, run_validations
from metaobjects.meta.core.attr.attr_constants import (
    ATTR_SUBTYPE_BOOLEAN,
    ATTR_SUBTYPE_FILTER,
    ATTR_SUBTYPE_STRINGARRAY,
)
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.identity.identity_constants import IDENTITY_SUBTYPE_PRIMARY
from metaobjects.meta.core.identity.meta_identity import MetaIdentity
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.meta.presentation.layout.layout_constants import (
    LAYOUT_ATTR_FILTER,
    LAYOUT_SUBTYPE_DATA_GRID,
)
from metaobjects.meta.presentation.layout.meta_layout import MetaLayout
from metaobjects.provider import compose_registry
from metaobjects.registry import TypeRegistry
from metaobjects.shared.base_types import (
    SUBTYPE_ROOT,
    TYPE_FIELD,
    TYPE_IDENTITY,
    TYPE_LAYOUT,
    TYPE_METADATA,
    TYPE_OBJECT,
)


def _make_registry() -> TypeRegistry:
    return compose_registry([core_provider])


def _errors_and_warnings(root: MetaData) -> tuple[list[MetaError], list[str]]:
    registry = _make_registry()
    errors: list[MetaError] = []
    warnings: list[str] = []
    run_validations(root, registry, errors, warnings)
    return errors, warnings


# ---------------------------------------------------------------------------
# Helper builder
# ---------------------------------------------------------------------------


def _build_root_with_filter(
    filter_dict: object,
    *,
    filterable_fields: list[tuple[str, str]] | None = None,
    non_filterable_fields: list[tuple[str, str]] | None = None,
) -> MetaData:
    """Build a minimal tree:
    root -> object.entity[Subscriber] with:
      - 'id' long field (not filterable)
      - fields in filterable_fields (name, sub_type) with @filterable: true
      - fields in non_filterable_fields (name, sub_type) without @filterable
      - identity.primary { @fields: [id] }
      - layout.dataGrid 'default' with the given @filter dict
    """
    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "")

    obj = MetaObject(TYPE_OBJECT, "entity", "Subscriber")
    root.add_child(obj)

    # id field (not filterable)
    obj.add_child(MetaField(TYPE_FIELD, "long", "id"))

    # filterable fields
    for fname, fsub in (filterable_fields or []):
        f = MetaField(TYPE_FIELD, fsub, fname)
        f.set_attr("filterable", True, ATTR_SUBTYPE_BOOLEAN)
        obj.add_child(f)

    # non-filterable fields
    for fname, fsub in (non_filterable_fields or []):
        obj.add_child(MetaField(TYPE_FIELD, fsub, fname))

    # primary identity on 'id'
    ident = MetaIdentity(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY, "")
    ident.set_attr("fields", ["id"], ATTR_SUBTYPE_STRINGARRAY)
    obj.add_child(ident)

    # layout.dataGrid with @filter
    layout = MetaLayout(TYPE_LAYOUT, LAYOUT_SUBTYPE_DATA_GRID, "default")
    if filter_dict is not None:
        layout.set_attr(LAYOUT_ATTR_FILTER, filter_dict, ATTR_SUBTYPE_FILTER)
    obj.add_child(layout)

    return root


# ---------------------------------------------------------------------------
# Test 1: @filter references a non-filterable field → ERR_BAD_ATTR_FILTER
# ---------------------------------------------------------------------------


def test_filter_non_filterable_field_produces_error() -> None:
    """A @filter clause referencing a non-filterable field must produce ERR_BAD_ATTR_FILTER."""
    root = _build_root_with_filter(
        {"notFilterable": "x"},
        non_filterable_fields=[("notFilterable", "string")],
    )

    errors, _ = _errors_and_warnings(root)

    codes = [e.code for e in errors]
    assert ErrorCode.ERR_BAD_ATTR_FILTER in codes, (
        f"Expected ERR_BAD_ATTR_FILTER in {codes}"
    )


# ---------------------------------------------------------------------------
# Test 2: @filter uses 'like' on a boolean field → ERR_BAD_ATTR_FILTER
# ---------------------------------------------------------------------------


def test_filter_disallowed_op_on_boolean_produces_error() -> None:
    """A @filter that uses 'like' on a boolean field must produce ERR_BAD_ATTR_FILTER."""
    root = _build_root_with_filter(
        {"subscribed": {"like": "x%"}},
        filterable_fields=[("subscribed", "boolean")],
    )

    errors, _ = _errors_and_warnings(root)

    codes = [e.code for e in errors]
    assert ErrorCode.ERR_BAD_ATTR_FILTER in codes, (
        f"Expected ERR_BAD_ATTR_FILTER in {codes}"
    )


# ---------------------------------------------------------------------------
# Test 3: valid filter → no ERR_BAD_ATTR_FILTER
# ---------------------------------------------------------------------------


def test_valid_filter_no_error() -> None:
    """Valid @filter clauses (allowed ops on filterable fields) must NOT produce ERR_BAD_ATTR_FILTER."""
    root = _build_root_with_filter(
        # email: {like: ...} valid for string; subscribed: {eq: true} valid for boolean
        {"email": {"like": "%@example.com"}, "subscribed": {"eq": True}},
        filterable_fields=[
            ("email", "string"),
            ("subscribed", "boolean"),
        ],
    )

    errors, _ = _errors_and_warnings(root)

    bad = [e for e in errors if e.code == ErrorCode.ERR_BAD_ATTR_FILTER]
    assert not bad, f"Unexpected ERR_BAD_ATTR_FILTER: {bad}"


# ---------------------------------------------------------------------------
# Tests: ops_for_subtype closed allowlist (TS/C# parity)
# ---------------------------------------------------------------------------


def test_ops_for_subtype_unknown_returns_empty() -> None:
    """An unknown field subtype must return an empty frozenset (closed allowlist).

    TS and C# both return [] for unrecognised subtypes; Python must match.
    field.object (and any extension subtype) has no filter-operator band.
    """
    assert ops_for_subtype("object") == frozenset()
    assert ops_for_subtype("blob") == frozenset()
    assert ops_for_subtype("") == frozenset()
    assert ops_for_subtype("custom.extension") == frozenset()


def test_ops_for_subtype_uuid() -> None:
    """SP-H Unit9 — uuid: identity-comparison only (no like, no ordering)."""
    assert ops_for_subtype("uuid") == frozenset({"eq", "ne", "in", "isNull"})


def test_ops_for_subtype_currency() -> None:
    """SP-H Unit9 — currency is integer minor units: numeric/orderable band."""
    assert ops_for_subtype("currency") == frozenset(
        {"eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"}
    )


def test_ops_for_subtype_enum() -> None:
    """SP-H Unit9 — enum is string-backed: string op band."""
    assert ops_for_subtype("enum") == frozenset({"eq", "ne", "in", "like", "isNull"})


def test_ops_for_subtype_string() -> None:
    """string subtype must return the string operator set."""
    ops = ops_for_subtype("string")
    assert ops == frozenset({"eq", "ne", "in", "like", "isNull"})


def test_ops_for_subtype_boolean() -> None:
    """boolean subtype must return only eq and isNull."""
    ops = ops_for_subtype("boolean")
    assert ops == frozenset({"eq", "isNull"})


def test_ops_for_subtype_numeric_subtypes() -> None:
    """Numeric and temporal subtypes must return the full numeric/temporal operator set."""
    numeric_temporal = {"int", "long", "double", "float", "decimal", "date", "time", "timestamp"}
    expected = frozenset({"eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"})
    for subtype in numeric_temporal:
        assert ops_for_subtype(subtype) == expected, (
            f"ops_for_subtype('{subtype}') should be {expected}"
        )
