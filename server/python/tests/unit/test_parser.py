from metaobjects.core_types import core_provider
from metaobjects.parser import parse_document
from metaobjects.provider import compose_registry

REG = compose_registry([core_provider])


def test_parses_empty_root() -> None:
    result = parse_document({"metadata.root": {}}, REG, source="x")
    assert not result.errors
    assert result.root.type == "metadata" and result.root.sub_type == "root"
    assert result.root.children() == []


def test_parses_entity_with_fields_and_desugars_identity_fields() -> None:
    doc = {
        "metadata.root": {
            "package": "acme::commerce",
            "children": [
                {"object.entity": {"name": "Product", "children": [
                    {"field.long": {"name": "id"}},
                    {"field.string": {"name": "name"}},
                    {"identity.primary": {"@fields": "id"}},
                ]}}
            ],
        }
    }
    result = parse_document(doc, REG, source="x")
    assert not result.errors
    root = result.root
    assert root.package == "acme::commerce"
    obj = root.children()[0]
    assert obj.name == "Product"
    ident = obj.children()[2]
    assert ident.attr("fields") == ["id"]  # desugared scalar -> array


def test_unknown_type_records_error() -> None:
    result = parse_document({"bogus.thing": {}}, REG, source="x")
    codes = [e.code.name for e in result.errors]
    assert "ERR_UNKNOWN_TYPE" in codes
