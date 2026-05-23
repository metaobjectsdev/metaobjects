import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes (set_attr needs them)
from metaobjects.codegen.type_map import py_type_for, PyType
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.shared.base_types import TYPE_FIELD


def _field(sub_type: str, *, is_array: bool = False, object_ref: str | None = None) -> MetaField:
    f = MetaField(TYPE_FIELD, sub_type, "x")
    f.is_array = is_array
    if object_ref is not None:
        f.set_attr(fc.FIELD_ATTR_OBJECT_REF, object_ref)
    return f


def test_scalar_subtypes_map():
    assert py_type_for(_field(fc.FIELD_SUBTYPE_STRING)).expr == "str"
    assert py_type_for(_field(fc.FIELD_SUBTYPE_INT)).expr == "int"
    assert py_type_for(_field(fc.FIELD_SUBTYPE_LONG)).expr == "int"
    assert py_type_for(_field(fc.FIELD_SUBTYPE_DOUBLE)).expr == "float"
    assert py_type_for(_field(fc.FIELD_SUBTYPE_FLOAT)).expr == "float"
    assert py_type_for(_field(fc.FIELD_SUBTYPE_BOOLEAN)).expr == "bool"
    assert py_type_for(_field(fc.FIELD_SUBTYPE_CLASS)).expr == "str"


def test_currency_is_int_minor_units():
    assert py_type_for(_field(fc.FIELD_SUBTYPE_CURRENCY)).expr == "int"


def test_decimal_and_datetime_carry_imports():
    dec = py_type_for(_field(fc.FIELD_SUBTYPE_DECIMAL))
    assert dec.expr == "Decimal" and "from decimal import Decimal" in dec.imports
    ts = py_type_for(_field(fc.FIELD_SUBTYPE_TIMESTAMP))
    assert ts.expr == "datetime.datetime" and "import datetime" in ts.imports
    assert py_type_for(_field(fc.FIELD_SUBTYPE_DATE)).expr == "datetime.date"
    assert py_type_for(_field(fc.FIELD_SUBTYPE_TIME)).expr == "datetime.time"


def test_object_uses_object_ref():
    assert py_type_for(_field(fc.FIELD_SUBTYPE_OBJECT, object_ref="PostBrief")).expr == "PostBrief"


def test_is_array_wraps_in_list():
    pt = py_type_for(_field(fc.FIELD_SUBTYPE_STRING, is_array=True))
    assert pt.expr == "list[str]"
    pt2 = py_type_for(_field(fc.FIELD_SUBTYPE_OBJECT, object_ref="PostBrief", is_array=True))
    assert pt2.expr == "list[PostBrief]"
