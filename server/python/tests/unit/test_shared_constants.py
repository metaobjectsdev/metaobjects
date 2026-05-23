from metaobjects.shared.base_types import (
    SUBTYPE_BASE,
    TYPE_ATTR,
    TYPE_FIELD,
    TYPE_IDENTITY,
    TYPE_METADATA,
    TYPE_OBJECT,
)
from metaobjects.shared.separators import ATTR_PREFIX, PACKAGE_SEP
from metaobjects.shared.structural import KEY_CHILDREN, KEY_NAME, KEY_PACKAGE


def test_separators() -> None:
    assert ATTR_PREFIX == "@"
    assert PACKAGE_SEP == "::"


def test_structural_keys() -> None:
    assert (KEY_NAME, KEY_PACKAGE, KEY_CHILDREN) == ("name", "package", "children")


def test_base_type_names() -> None:
    assert TYPE_METADATA == "metadata"
    assert TYPE_OBJECT == "object"
    assert TYPE_FIELD == "field"
    assert TYPE_ATTR == "attr"
    assert TYPE_IDENTITY == "identity"
    assert SUBTYPE_BASE == "base"
