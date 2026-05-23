"""Unit tests for the dataGrid @defaultSortField validation pass (Task P4.2)."""
from __future__ import annotations

from metaobjects.core_types import core_provider
from metaobjects.errors import ErrorCode, MetaError
from metaobjects.loader.validation_passes import run_validations
from metaobjects.meta.core.attr.attr_constants import (
    ATTR_SUBTYPE_STRING,
    ATTR_SUBTYPE_STRINGARRAY,
)
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.provider import compose_registry
from metaobjects.registry import TypeRegistry
from metaobjects.shared.base_types import (
    SUBTYPE_ROOT,
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
# Helper builders
# ---------------------------------------------------------------------------


def _build_tree(default_sort_field: str) -> MetaData:
    """Build a minimal tree: root -> object.entity[Subscriber] with fields
    [id, email] + a layout.dataGrid referencing *default_sort_field*."""
    from metaobjects.meta.core.field.meta_field import MetaField
    from metaobjects.meta.core.object.meta_object import MetaObject
    from metaobjects.meta.presentation.layout.meta_layout import MetaLayout
    from metaobjects.meta.presentation.layout.layout_constants import (
        LAYOUT_ATTR_DEFAULT_SORT_FIELD,
        LAYOUT_SUBTYPE_DATA_GRID,
    )

    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "")

    obj = MetaObject(TYPE_OBJECT, "entity", "Subscriber")
    root.add_child(obj)

    for field_name, sub in [("id", "long"), ("email", "string")]:
        field = MetaField("field", sub, field_name)
        obj.add_child(field)

    layout = MetaLayout(TYPE_LAYOUT, LAYOUT_SUBTYPE_DATA_GRID, "default")
    layout.set_attr(LAYOUT_ATTR_DEFAULT_SORT_FIELD, default_sort_field, ATTR_SUBTYPE_STRING)
    obj.add_child(layout)

    return root


# ---------------------------------------------------------------------------
# Test 1: invalid @defaultSortField → ERR_BAD_DEFAULT_SORT_FIELD
# ---------------------------------------------------------------------------


def test_bad_default_sort_field_produces_error() -> None:
    """A dataGrid whose @defaultSortField references a non-existent field name
    must produce ERR_BAD_DEFAULT_SORT_FIELD."""
    root = _build_tree("doesNotExist")

    errors, _ = _errors_and_warnings(root)

    codes = [e.code for e in errors]
    assert ErrorCode.ERR_BAD_DEFAULT_SORT_FIELD in codes, (
        f"Expected ERR_BAD_DEFAULT_SORT_FIELD in {codes}"
    )


# ---------------------------------------------------------------------------
# Test 2: valid @defaultSortField → no error
# ---------------------------------------------------------------------------


def test_valid_default_sort_field_no_error() -> None:
    """A dataGrid whose @defaultSortField matches an actual field name must NOT
    produce ERR_BAD_DEFAULT_SORT_FIELD."""
    root = _build_tree("email")

    errors, _ = _errors_and_warnings(root)

    bad = [e for e in errors if e.code == ErrorCode.ERR_BAD_DEFAULT_SORT_FIELD]
    assert not bad, f"Unexpected ERR_BAD_DEFAULT_SORT_FIELD: {bad}"
