"""Unit tests for the attr-schema validation pass (Task P4.1)."""
from __future__ import annotations

from metaobjects.core_types import core_provider
from metaobjects.errors import ErrorCode, MetaError
from metaobjects.loader.validation_passes import run_validations
from metaobjects.meta.core.attr.attr_constants import (
    ATTR_SUBTYPE_INT,
    ATTR_SUBTYPE_STRING,
    ATTR_SUBTYPE_STRINGARRAY,
)
from metaobjects.meta.core.identity.identity_constants import IDENTITY_ATTR_FIELDS
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.provider import compose_registry
from metaobjects.registry import TypeRegistry
from metaobjects.shared.base_types import (
    SUBTYPE_ROOT,
    TYPE_IDENTITY,
    TYPE_LAYOUT,
    TYPE_METADATA,
    TYPE_ORIGIN,
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
# Helper: build a minimal tree for testing
# ---------------------------------------------------------------------------


def _root_with_child(child: MetaData) -> MetaData:
    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "")
    root.add_child(child)
    return root


def _make_node(type_: str, sub_type: str, name: str) -> MetaData:
    """Create a bare MetaData-like node (using MetaRoot as a generic container)."""
    from metaobjects.meta.meta_data import MetaData

    node = MetaData.__new__(MetaData)
    MetaData.__init__(node, type_, sub_type, name)
    return node


# ---------------------------------------------------------------------------
# Test 1: ERR_MISSING_REQUIRED_ATTR — identity.primary missing @fields
# ---------------------------------------------------------------------------


def test_missing_required_attr_identity_primary() -> None:
    """identity.primary with no @fields should produce ERR_MISSING_REQUIRED_ATTR."""
    from metaobjects.meta.core.identity.meta_identity import MetaIdentity

    ident = MetaIdentity(TYPE_IDENTITY, "primary", "pk")
    root = _root_with_child(ident)

    errors, warnings = _errors_and_warnings(root)

    codes = [e.code for e in errors]
    assert ErrorCode.ERR_MISSING_REQUIRED_ATTR in codes, (
        f"Expected ERR_MISSING_REQUIRED_ATTR; got {codes}"
    )


def test_no_missing_required_attr_when_fields_present() -> None:
    """identity.primary with @fields must NOT produce ERR_MISSING_REQUIRED_ATTR."""
    from metaobjects.meta.core.identity.meta_identity import MetaIdentity

    ident = MetaIdentity(TYPE_IDENTITY, "primary", "pk")
    ident.set_attr(IDENTITY_ATTR_FIELDS, ["id"], ATTR_SUBTYPE_STRINGARRAY)
    root = _root_with_child(ident)

    errors, _ = _errors_and_warnings(root)

    missing = [e for e in errors if e.code == ErrorCode.ERR_MISSING_REQUIRED_ATTR]
    assert not missing, f"Unexpected ERR_MISSING_REQUIRED_ATTR: {missing}"


# ---------------------------------------------------------------------------
# Test 2: ERR_BAD_ATTR_VALUE (type check) — layout.dataGrid @pageSize wrong type
# ---------------------------------------------------------------------------


def test_bad_attr_value_wrong_type_page_size() -> None:
    """layout.dataGrid with @pageSize='twenty-five' (string) should produce ERR_BAD_ATTR_VALUE."""
    from metaobjects.meta.presentation.layout.meta_layout import MetaLayout
    from metaobjects.meta.presentation.layout.layout_constants import LAYOUT_ATTR_PAGE_SIZE

    layout = MetaLayout(TYPE_LAYOUT, "dataGrid", "default")
    # Provide a string value for an int-typed attr
    layout.set_attr(LAYOUT_ATTR_PAGE_SIZE, "twenty-five", ATTR_SUBTYPE_STRING)
    root = _root_with_child(layout)

    errors, _ = _errors_and_warnings(root)

    codes = [e.code for e in errors]
    assert ErrorCode.ERR_BAD_ATTR_VALUE in codes, (
        f"Expected ERR_BAD_ATTR_VALUE; got {codes}"
    )


def test_no_bad_attr_value_when_page_size_int() -> None:
    """layout.dataGrid with @pageSize=25 (int) must NOT produce ERR_BAD_ATTR_VALUE."""
    from metaobjects.meta.presentation.layout.meta_layout import MetaLayout
    from metaobjects.meta.presentation.layout.layout_constants import LAYOUT_ATTR_PAGE_SIZE

    layout = MetaLayout(TYPE_LAYOUT, "dataGrid", "default")
    layout.set_attr(LAYOUT_ATTR_PAGE_SIZE, 25, ATTR_SUBTYPE_INT)
    root = _root_with_child(layout)

    errors, _ = _errors_and_warnings(root)

    bad = [e for e in errors if e.code == ErrorCode.ERR_BAD_ATTR_VALUE]
    assert not bad, f"Unexpected ERR_BAD_ATTR_VALUE: {bad}"


# ---------------------------------------------------------------------------
# Test 3: ERR_BAD_ATTR_VALUE (allowed_values) — origin.aggregate @agg bad value
# ---------------------------------------------------------------------------


def test_bad_attr_value_allowed_values_agg() -> None:
    """origin.aggregate with @agg='notARealFn' should produce ERR_BAD_ATTR_VALUE."""
    from metaobjects.meta.persistence.origin.meta_origin import MetaOrigin

    origin = MetaOrigin(TYPE_ORIGIN, "aggregate", "")
    origin.set_attr("agg", "notARealFn", ATTR_SUBTYPE_STRING)
    origin.set_attr("of", "Week.id", ATTR_SUBTYPE_STRING)
    origin.set_attr("via", "Program.weeks", ATTR_SUBTYPE_STRING)
    root = _root_with_child(origin)

    errors, _ = _errors_and_warnings(root)

    codes = [e.code for e in errors]
    assert ErrorCode.ERR_BAD_ATTR_VALUE in codes, (
        f"Expected ERR_BAD_ATTR_VALUE for bad @agg; got {codes}"
    )


def test_no_bad_attr_value_when_agg_valid() -> None:
    """origin.aggregate with @agg='count' must NOT produce ERR_BAD_ATTR_VALUE."""
    from metaobjects.meta.persistence.origin.meta_origin import MetaOrigin

    origin = MetaOrigin(TYPE_ORIGIN, "aggregate", "")
    origin.set_attr("agg", "count", ATTR_SUBTYPE_STRING)
    origin.set_attr("of", "Week.id", ATTR_SUBTYPE_STRING)
    origin.set_attr("via", "Program.weeks", ATTR_SUBTYPE_STRING)
    root = _root_with_child(origin)

    errors, _ = _errors_and_warnings(root)

    bad = [e for e in errors if e.code == ErrorCode.ERR_BAD_ATTR_VALUE]
    assert not bad, f"Unexpected ERR_BAD_ATTR_VALUE: {bad}"


# ---------------------------------------------------------------------------
# Test 4: ERR_BAD_ATTR_VALUE (type check) — filter attr given a string (legacy)
# ---------------------------------------------------------------------------


def test_bad_attr_value_filter_legacy_string() -> None:
    """layout.dataGrid with @filter as a string should produce ERR_BAD_ATTR_VALUE."""
    from metaobjects.meta.presentation.layout.meta_layout import MetaLayout

    layout = MetaLayout(TYPE_LAYOUT, "dataGrid", "default")
    # Pass the string directly — this is the legacy string form
    layout.set_attr("filter", '{"subscribed":true}', ATTR_SUBTYPE_STRING)
    root = _root_with_child(layout)

    errors, _ = _errors_and_warnings(root)

    codes = [e.code for e in errors]
    assert ErrorCode.ERR_BAD_ATTR_VALUE in codes, (
        f"Expected ERR_BAD_ATTR_VALUE for legacy string @filter; got {codes}"
    )


# ---------------------------------------------------------------------------
# Test 5: ERR_BAD_ATTR_VALUE — identity.primary @generation bad allowed value
# ---------------------------------------------------------------------------


def test_bad_attr_value_generation_not_allowed() -> None:
    """identity.primary with @generation='sequence' should produce ERR_BAD_ATTR_VALUE."""
    from metaobjects.meta.core.identity.meta_identity import MetaIdentity

    ident = MetaIdentity(TYPE_IDENTITY, "primary", "pk")
    ident.set_attr(IDENTITY_ATTR_FIELDS, ["id"], ATTR_SUBTYPE_STRINGARRAY)
    ident.set_attr("generation", "sequence", ATTR_SUBTYPE_STRING)
    root = _root_with_child(ident)

    errors, _ = _errors_and_warnings(root)

    codes = [e.code for e in errors]
    assert ErrorCode.ERR_BAD_ATTR_VALUE in codes, (
        f"Expected ERR_BAD_ATTR_VALUE for @generation='sequence'; got {codes}"
    )


def test_no_bad_attr_value_generation_valid() -> None:
    """identity.primary with @generation='increment' must NOT produce ERR_BAD_ATTR_VALUE."""
    from metaobjects.meta.core.identity.meta_identity import MetaIdentity

    ident = MetaIdentity(TYPE_IDENTITY, "primary", "pk")
    ident.set_attr(IDENTITY_ATTR_FIELDS, ["id"], ATTR_SUBTYPE_STRINGARRAY)
    ident.set_attr("generation", "increment", ATTR_SUBTYPE_STRING)
    root = _root_with_child(ident)

    errors, _ = _errors_and_warnings(root)

    bad = [e for e in errors if e.code == ErrorCode.ERR_BAD_ATTR_VALUE]
    assert not bad, f"Unexpected ERR_BAD_ATTR_VALUE: {bad}"
