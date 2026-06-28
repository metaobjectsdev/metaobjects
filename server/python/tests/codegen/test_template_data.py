from pathlib import Path

from metaobjects import MetaDataLoader
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.codegen.template_codegen.template_data import (
    build_entity_template_data,
    build_model_template_data,
)

CORPUS = Path(__file__).resolve().parents[4] / "fixtures" / "template-codegen-conformance"


def _objects():
    root = MetaDataLoader.from_directory(str(CORPUS / "metadata")).root
    return [c for c in root.children() if isinstance(c, MetaObject)]


def _obj(name: str):
    return next(o for o in _objects() if o.name == name)


def test_entity_dict_neutral_fields() -> None:
    d = build_entity_template_data(_obj("Product"))
    assert d["name"] == "Product"
    assert d["package"] == "shop"

    fields = {f["name"]: f for f in d["fields"]}
    assert fields["name"]["type"] == "string"
    assert fields["name"]["required"] is True
    assert fields["name"]["isArray"] is False
    assert fields["name"]["maxLength"] == 120
    assert fields["status"]["type"] == "enum"
    assert fields["status"]["enumValues"] == ["ACTIVE", "ARCHIVED"]
    # id has no maxLength/enumValues — keys ABSENT, not None
    assert "maxLength" not in fields["id"]
    assert "enumValues" not in fields["id"]


def test_order_relationship() -> None:
    d = build_entity_template_data(_obj("Order"))
    assert d["relationships"] == [
        {"name": "product", "cardinality": "one", "targetRef": "Product"}
    ]


def test_model_groups_by_package() -> None:
    model = build_model_template_data(_objects())
    assert len(model["packages"]) == 1
    assert model["packages"][0]["package"] == "shop"
    assert len(model["packages"][0]["entities"]) == 2
