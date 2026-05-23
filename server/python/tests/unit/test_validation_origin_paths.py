"""Unit tests for the origin @from/@of/@via path validation pass (Task P4.4)."""
from __future__ import annotations

from metaobjects.core_types import core_provider
from metaobjects.errors import ErrorCode, MetaError
from metaobjects.loader.validation_passes import run_validations
from metaobjects.meta.core.attr.attr_constants import ATTR_SUBTYPE_STRING
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.provider import compose_registry
from metaobjects.registry import TypeRegistry
from metaobjects.shared.base_types import (
    SUBTYPE_ROOT,
    TYPE_FIELD,
    TYPE_METADATA,
    TYPE_OBJECT,
    TYPE_ORIGIN,
    TYPE_RELATIONSHIP,
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


def _build_aggregate_tree(via: str, of: str) -> MetaData:
    """Build a minimal tree modelling the origin-aggregate-count fixture:
      - Program (with a 'weeks' relationship → Week)
      - Week (with 'id' and 'name' fields)
      - ProgramSummary (extends Program) with an origin.aggregate field
        using *via* and *of*.
    """
    from metaobjects.meta.core.field.meta_field import MetaField
    from metaobjects.meta.core.object.meta_object import MetaObject
    from metaobjects.meta.core.relationship.meta_relationship import MetaRelationship
    from metaobjects.meta.core.relationship.relationship_constants import (
        RELATIONSHIP_ATTR_OBJECT_REF,
    )

    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "")

    # Program entity
    program = MetaObject(TYPE_OBJECT, "entity", "Program")
    prog_id = MetaField(TYPE_FIELD, "long", "id")
    program.add_child(prog_id)
    prog_title = MetaField(TYPE_FIELD, "string", "title")
    program.add_child(prog_title)
    weeks_rel = MetaRelationship(TYPE_RELATIONSHIP, "association", "weeks")
    weeks_rel.set_attr(RELATIONSHIP_ATTR_OBJECT_REF, "Week", ATTR_SUBTYPE_STRING)
    program.add_child(weeks_rel)
    root.add_child(program)

    # Week entity
    week = MetaObject(TYPE_OBJECT, "entity", "Week")
    week_id = MetaField(TYPE_FIELD, "long", "id")
    week.add_child(week_id)
    week_name = MetaField(TYPE_FIELD, "string", "name")
    week.add_child(week_name)
    root.add_child(week)

    # ProgramSummary entity with an origin.aggregate field
    summary = MetaObject(TYPE_OBJECT, "entity", "ProgramSummary")
    field = MetaField(TYPE_FIELD, "int", "weekCount")
    origin = MetaData(TYPE_ORIGIN, "aggregate", "")
    origin.set_attr("agg", "count", ATTR_SUBTYPE_STRING)
    origin.set_attr("of", of, ATTR_SUBTYPE_STRING)
    origin.set_attr("via", via, ATTR_SUBTYPE_STRING)
    field.add_child(origin)
    summary.add_child(field)
    root.add_child(summary)

    return root


def _build_passthrough_tree(from_ref: str) -> MetaData:
    """Build a minimal tree with an origin.passthrough field using *from_ref*.
      - Program (with 'id' and 'title' fields)
      - ProgramSummary (extends Program) with an origin.passthrough field
    """
    from metaobjects.meta.core.field.meta_field import MetaField
    from metaobjects.meta.core.object.meta_object import MetaObject

    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "")

    program = MetaObject(TYPE_OBJECT, "entity", "Program")
    prog_id = MetaField(TYPE_FIELD, "long", "id")
    program.add_child(prog_id)
    prog_title = MetaField(TYPE_FIELD, "string", "title")
    program.add_child(prog_title)
    root.add_child(program)

    summary = MetaObject(TYPE_OBJECT, "entity", "ProgramSummary")
    field = MetaField(TYPE_FIELD, "string", "displayTitle")
    origin = MetaData(TYPE_ORIGIN, "passthrough", "")
    origin.set_attr("from", from_ref, ATTR_SUBTYPE_STRING)
    field.add_child(origin)
    summary.add_child(field)
    root.add_child(summary)

    return root


# ---------------------------------------------------------------------------
# Tests: origin.aggregate @via validation
# ---------------------------------------------------------------------------


def test_valid_aggregate_via_no_error() -> None:
    """A valid @via='Program.weeks' with Program having a 'weeks' relationship
    targeting Week must NOT produce ERR_INVALID_ORIGIN."""
    root = _build_aggregate_tree(via="Program.weeks", of="Week.id")
    errors, _ = _errors_and_warnings(root)
    bad = [e for e in errors if e.code == ErrorCode.ERR_INVALID_ORIGIN]
    assert not bad, f"Unexpected ERR_INVALID_ORIGIN: {bad}"


def test_invalid_aggregate_via_bad_relationship() -> None:
    """@via='Program.nope' where Program has no 'nope' relationship
    must produce ERR_INVALID_ORIGIN."""
    root = _build_aggregate_tree(via="Program.nope", of="Week.id")
    errors, _ = _errors_and_warnings(root)
    codes = [e.code for e in errors]
    assert ErrorCode.ERR_INVALID_ORIGIN in codes, (
        f"Expected ERR_INVALID_ORIGIN in {codes}"
    )


# ---------------------------------------------------------------------------
# Tests: origin.aggregate @of validation
# ---------------------------------------------------------------------------


def test_valid_aggregate_of_no_error() -> None:
    """A valid @of='Week.id' (Week has field 'id') must NOT produce ERR_INVALID_ORIGIN."""
    root = _build_aggregate_tree(via="Program.weeks", of="Week.id")
    errors, _ = _errors_and_warnings(root)
    bad = [e for e in errors if e.code == ErrorCode.ERR_INVALID_ORIGIN]
    assert not bad, f"Unexpected ERR_INVALID_ORIGIN: {bad}"


def test_invalid_aggregate_of_bad_field() -> None:
    """@of='Week.nope' where Week has no field 'nope' must produce ERR_INVALID_ORIGIN."""
    root = _build_aggregate_tree(via="Program.weeks", of="Week.nope")
    errors, _ = _errors_and_warnings(root)
    codes = [e.code for e in errors]
    assert ErrorCode.ERR_INVALID_ORIGIN in codes, (
        f"Expected ERR_INVALID_ORIGIN in {codes}"
    )


def test_invalid_aggregate_of_unknown_entity() -> None:
    """@of='Ghost.id' where Ghost doesn't exist must produce ERR_INVALID_ORIGIN."""
    root = _build_aggregate_tree(via="Program.weeks", of="Ghost.id")
    errors, _ = _errors_and_warnings(root)
    codes = [e.code for e in errors]
    assert ErrorCode.ERR_INVALID_ORIGIN in codes, (
        f"Expected ERR_INVALID_ORIGIN in {codes}"
    )


# ---------------------------------------------------------------------------
# Tests: origin.passthrough @from validation
# ---------------------------------------------------------------------------


def test_valid_passthrough_from_no_error() -> None:
    """A valid @from='Program.title' (Program has field 'title') must NOT produce
    ERR_INVALID_ORIGIN."""
    root = _build_passthrough_tree(from_ref="Program.title")
    errors, _ = _errors_and_warnings(root)
    bad = [e for e in errors if e.code == ErrorCode.ERR_INVALID_ORIGIN]
    assert not bad, f"Unexpected ERR_INVALID_ORIGIN: {bad}"


def test_invalid_passthrough_from_bad_field() -> None:
    """@from='Program.nope' where Program has no field 'nope' must produce
    ERR_INVALID_ORIGIN."""
    root = _build_passthrough_tree(from_ref="Program.nope")
    errors, _ = _errors_and_warnings(root)
    codes = [e.code for e in errors]
    assert ErrorCode.ERR_INVALID_ORIGIN in codes, (
        f"Expected ERR_INVALID_ORIGIN in {codes}"
    )


def test_invalid_passthrough_from_unknown_entity() -> None:
    """@from='Ghost.title' where Ghost doesn't exist must produce ERR_INVALID_ORIGIN."""
    root = _build_passthrough_tree(from_ref="Ghost.title")
    errors, _ = _errors_and_warnings(root)
    codes = [e.code for e in errors]
    assert ErrorCode.ERR_INVALID_ORIGIN in codes, (
        f"Expected ERR_INVALID_ORIGIN in {codes}"
    )


# ---------------------------------------------------------------------------
# Tests: missing required origin attrs emit ERR_INVALID_ORIGIN (TS parity)
# ---------------------------------------------------------------------------
# The TS reference emits ERR_INVALID_ORIGIN for a *missing* required attr
# IN ADDITION to the attr-schema pass's ERR_MISSING_REQUIRED_ATTR.


def _build_aggregate_tree_missing_attrs() -> MetaData:
    """Build a minimal tree with an origin.aggregate node that has NO @of or @via."""
    from metaobjects.meta.core.field.meta_field import MetaField
    from metaobjects.meta.core.object.meta_object import MetaObject

    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "")

    program = MetaObject(TYPE_OBJECT, "entity", "Program")
    prog_id = MetaField(TYPE_FIELD, "long", "id")
    program.add_child(prog_id)
    root.add_child(program)

    summary = MetaObject(TYPE_OBJECT, "entity", "ProgramSummary")
    field = MetaField(TYPE_FIELD, "int", "weekCount")
    # origin.aggregate with neither @of nor @via set
    origin = MetaData(TYPE_ORIGIN, "aggregate", "")
    field.add_child(origin)
    summary.add_child(field)
    root.add_child(summary)

    return root


def _build_passthrough_tree_missing_from() -> MetaData:
    """Build a minimal tree with an origin.passthrough node that has NO @from."""
    from metaobjects.meta.core.field.meta_field import MetaField
    from metaobjects.meta.core.object.meta_object import MetaObject

    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "")

    program = MetaObject(TYPE_OBJECT, "entity", "Program")
    prog_id = MetaField(TYPE_FIELD, "long", "id")
    program.add_child(prog_id)
    root.add_child(program)

    summary = MetaObject(TYPE_OBJECT, "entity", "ProgramSummary")
    field = MetaField(TYPE_FIELD, "string", "displayTitle")
    # origin.passthrough with no @from
    origin = MetaData(TYPE_ORIGIN, "passthrough", "")
    field.add_child(origin)
    summary.add_child(field)
    root.add_child(summary)

    return root


def test_aggregate_missing_of_emits_err_invalid_origin() -> None:
    """An origin.aggregate with no @of must emit ERR_INVALID_ORIGIN.

    ERR_MISSING_REQUIRED_ATTR may also be present (from the attr-schema pass);
    this test only asserts that ERR_INVALID_ORIGIN is included too (TS parity).
    """
    root = _build_aggregate_tree_missing_attrs()
    errors, _ = _errors_and_warnings(root)
    codes = [e.code for e in errors]
    assert ErrorCode.ERR_INVALID_ORIGIN in codes, (
        f"Expected ERR_INVALID_ORIGIN for missing @of; got codes: {codes}"
    )


def test_aggregate_missing_via_emits_err_invalid_origin() -> None:
    """An origin.aggregate with no @via must emit ERR_INVALID_ORIGIN."""
    root = _build_aggregate_tree_missing_attrs()
    errors, _ = _errors_and_warnings(root)
    codes = [e.code for e in errors]
    # Both @of and @via are missing — ERR_INVALID_ORIGIN should appear at least once
    invalid_origin_errors = [e for e in errors if e.code == ErrorCode.ERR_INVALID_ORIGIN]
    assert len(invalid_origin_errors) >= 2, (
        f"Expected at least 2 ERR_INVALID_ORIGIN errors (one for @of, one for @via); "
        f"got: {invalid_origin_errors}"
    )


def test_passthrough_missing_from_emits_err_invalid_origin() -> None:
    """An origin.passthrough with no @from must emit ERR_INVALID_ORIGIN."""
    root = _build_passthrough_tree_missing_from()
    errors, _ = _errors_and_warnings(root)
    codes = [e.code for e in errors]
    assert ErrorCode.ERR_INVALID_ORIGIN in codes, (
        f"Expected ERR_INVALID_ORIGIN for missing @from; got codes: {codes}"
    )
