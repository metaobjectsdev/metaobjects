import json

import metaobjects.core_types  # noqa: F401  (triggers attr-class registration for set_attr)
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.identity.meta_identity import MetaIdentity
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.serializer_json import canonical_serialize


def test_empty_root() -> None:
    root = MetaRoot("metadata", "root", "")
    assert json.loads(canonical_serialize(root)) == {"metadata.root": {}}


def test_root_with_package_only() -> None:
    root = MetaRoot("metadata", "root", "")
    root.package = "acme"
    assert json.loads(canonical_serialize(root)) == {"metadata.root": {"package": "acme"}}


def test_entity_with_fields_and_identity_fields_array() -> None:
    root = MetaRoot("metadata", "root", "")
    root.package = "acme::commerce"
    obj = MetaObject("object", "entity", "Product")
    obj.add_child(MetaField("field", "long", "id"))
    obj.add_child(MetaField("field", "string", "name"))
    ident = MetaIdentity("identity", "primary", "")
    ident.set_attr("fields", "id", sub_type="stringarray")
    obj.add_child(ident)
    root.add_child(obj)

    expected = {
        "metadata.root": {
            "package": "acme::commerce",
            "children": [
                {"object.entity": {"name": "Product", "children": [
                    {"field.long": {"name": "id"}},
                    {"field.string": {"name": "name"}},
                    {"identity.primary": {"@fields": ["id"]}},
                ]}}
            ],
        }
    }
    assert json.loads(canonical_serialize(root)) == expected


def test_trailing_newline_and_indent() -> None:
    root = MetaRoot("metadata", "root", "")
    out = canonical_serialize(root)
    assert out.endswith("\n")
    assert "\n  " in canonical_serialize_nonempty_example()


def canonical_serialize_nonempty_example() -> str:
    root = MetaRoot("metadata", "root", "")
    root.package = "acme"
    return canonical_serialize(root)
