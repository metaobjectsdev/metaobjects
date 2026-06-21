import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes (set_attr needs them)
from metaobjects.codegen.type_map import py_type_for
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.shared.base_types import TYPE_FIELD


def _field(
    sub_type: str,
    *,
    is_array: bool = False,
    object_ref: str | None = None,
    value_type: str | None = None,
) -> MetaField:
    f = MetaField(TYPE_FIELD, sub_type, "x")
    f.is_array = is_array
    if object_ref is not None:
        f.set_attr(fc.FIELD_ATTR_OBJECT_REF, object_ref)
    if value_type is not None:
        f.set_attr(fc.FIELD_ATTR_VALUE_TYPE, value_type)
    return f


def test_scalar_subtypes_map() -> None:
    assert py_type_for(_field(fc.FIELD_SUBTYPE_STRING)).expr == "str"
    assert py_type_for(_field(fc.FIELD_SUBTYPE_INT)).expr == "int"
    assert py_type_for(_field(fc.FIELD_SUBTYPE_LONG)).expr == "int"
    assert py_type_for(_field(fc.FIELD_SUBTYPE_DOUBLE)).expr == "float"
    assert py_type_for(_field(fc.FIELD_SUBTYPE_FLOAT)).expr == "float"
    assert py_type_for(_field(fc.FIELD_SUBTYPE_BOOLEAN)).expr == "bool"


def test_currency_is_int_minor_units() -> None:
    assert py_type_for(_field(fc.FIELD_SUBTYPE_CURRENCY)).expr == "int"


def test_decimal_and_datetime_carry_imports() -> None:
    dec = py_type_for(_field(fc.FIELD_SUBTYPE_DECIMAL))
    assert dec.expr == "Decimal" and "from decimal import Decimal" in dec.imports
    ts = py_type_for(_field(fc.FIELD_SUBTYPE_TIMESTAMP))
    assert ts.expr == "datetime.datetime" and "import datetime" in ts.imports
    assert py_type_for(_field(fc.FIELD_SUBTYPE_DATE)).expr == "datetime.date"
    assert py_type_for(_field(fc.FIELD_SUBTYPE_TIME)).expr == "datetime.time"


def test_object_uses_object_ref() -> None:
    assert py_type_for(_field(fc.FIELD_SUBTYPE_OBJECT, object_ref="PostBrief")).expr == "PostBrief"


def test_is_array_wraps_in_list() -> None:
    pt = py_type_for(_field(fc.FIELD_SUBTYPE_STRING, is_array=True))
    assert pt.expr == "list[str]"
    pt2 = py_type_for(_field(fc.FIELD_SUBTYPE_OBJECT, object_ref="PostBrief", is_array=True))
    assert pt2.expr == "list[PostBrief]"


def test_is_array_via_attr_form() -> None:
    # `@isArray` loads as an attr (not the node property) — the conformance-fixture form.
    f = MetaField(TYPE_FIELD, fc.FIELD_SUBTYPE_STRING, "x")
    f.set_attr("isArray", True)
    assert py_type_for(f).expr == "list[str]"


def test_uuid_binds_native_uuid_with_import() -> None:
    # R6 Plan 2a — field.uuid binds the idiomatic native uuid.UUID (ADR-0001).
    t = py_type_for(_field(fc.FIELD_SUBTYPE_UUID))
    assert t.expr == "uuid.UUID"
    assert "import uuid" in t.imports


def test_map_with_scalar_value_type() -> None:
    # field.map → dict[str, V]; V is the scalar Python type for @valueType.
    assert py_type_for(_field(fc.FIELD_SUBTYPE_MAP, value_type="string")).expr == "dict[str, str]"
    assert py_type_for(_field(fc.FIELD_SUBTYPE_MAP, value_type="int")).expr == "dict[str, int]"
    # A scalar value type that carries an import propagates it to the map type.
    dec = py_type_for(_field(fc.FIELD_SUBTYPE_MAP, value_type="decimal"))
    assert dec.expr == "dict[str, Decimal]" and "from decimal import Decimal" in dec.imports


def test_map_with_object_ref() -> None:
    # field.map with @objectRef → dict[str, <VO bare name>] (FQN folded to base).
    assert py_type_for(_field(fc.FIELD_SUBTYPE_MAP, object_ref="SomeVO")).expr == "dict[str, SomeVO]"
    assert (
        py_type_for(_field(fc.FIELD_SUBTYPE_MAP, object_ref="acme::pkg::SomeVO")).expr
        == "dict[str, SomeVO]"
    )


def test_map_is_never_wrapped_in_list() -> None:
    # isArray does not apply to a map — it is a single jsonb/object column.
    assert (
        py_type_for(_field(fc.FIELD_SUBTYPE_MAP, value_type="string", is_array=True)).expr
        == "dict[str, str]"
    )


def test_dbcolumntype_uuid_string_stays_str() -> None:
    # R6 Plan 2b — @dbColumnType:uuid only changes the DB column type; the native
    # binding of a field.string is unchanged (stays a Python str).
    from metaobjects.meta.persistence.db import db_constants as dbc

    f = _field(fc.FIELD_SUBTYPE_STRING)
    f.set_attr(dbc.FIELD_ATTR_DB_COLUMN_TYPE, dbc.DB_COLUMN_TYPE_UUID)
    assert py_type_for(f).expr == "str"
