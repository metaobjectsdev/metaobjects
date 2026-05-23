from metaobjects.meta.core.attr.attr_constants import (
    ATTR_SUBTYPE_BOOLEAN,
    ATTR_SUBTYPE_STRING,
    ATTR_SUBTYPE_STRINGARRAY,
)
from metaobjects.meta.core.attr.meta_attr import MetaAttr, StringArrayAttr


def test_string_attr_coerces_and_keeps_value() -> None:
    a = MetaAttr("attr", ATTR_SUBTYPE_STRING, "label")
    a.set_value("hi")
    assert a.value == "hi"


def test_boolean_attr_coerces() -> None:
    a = MetaAttr("attr", ATTR_SUBTYPE_BOOLEAN, "flag")
    a.set_value(True)
    assert a.value is True


def test_string_array_desugars_scalar_to_list() -> None:
    a = StringArrayAttr("attr", ATTR_SUBTYPE_STRINGARRAY, "fields")
    a.set_value("id")
    assert a.value == ["id"]
    b = StringArrayAttr("attr", ATTR_SUBTYPE_STRINGARRAY, "fields")
    b.set_value(["a", "b"])
    assert b.value == ["a", "b"]
