"""The Python example generator in docs/recipes/generators/python/ must keep working, because
the guidance tells adopters to copy it (ADR-0034 Amendment 4).

The gate does what an adopter does: copies the file verbatim into ``codegen/generators/``,
wires it as ``module:symbol`` in ``metaobjects.config.yaml``, runs ``gen``, checks what it
emitted, runs ``verify --codegen`` clean, then changes the MODEL and expects the gate to
convict the stale output. The file is an example, not a product surface — this exists so it
cannot rot against the ``metaobjects.codegen.model_walk`` API it imports.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from metaobjects.cli import main
from metaobjects.codegen.model_walk import (
    enum_values,
    field_is_array,
    is_required,
    max_length,
    object_ref_target,
)
from metaobjects import MetaDataLoader

RECIPE = Path(__file__).parents[4] / "docs" / "recipes" / "generators" / "python" / "json_schema.py"

SHOP: dict = {
    "metadata": {
        "package": "shop",
        "children": [
            {"object.value": {"name": "Address", "children": [
                {"field.string": {"name": "city", "@required": True}},
            ]}},
            {"object.entity": {"name": "BaseEntity", "abstract": True, "children": [
                {"field.long": {"name": "id"}},
                {"field.timestamp": {"name": "createdAt", "@required": True}},
                {"field.string": {"name": "labels", "isArray": True, "@maxLength": 40}},
                {"identity.primary": {"name": "pk", "@fields": ["id"]}},
            ]}},
            {"object.entity": {"name": "Customer", "extends": "BaseEntity", "children": [
                {"source.rdb": {"@table": "customers"}},
                {"field.string": {"name": "email", "@required": True}},
                {"field.object": {"name": "shipping", "@objectRef": "Address", "@storage": "jsonb"}},
                {"field.enum": {"name": "tier", "@values": ["free", "paid"]}},
            ]}},
        ],
    }
}


def _project(tmp_path: Path) -> Path:
    (tmp_path / "metaobjects").mkdir()
    (tmp_path / "metaobjects" / "meta.shop.json").write_text(json.dumps(SHOP))
    gens = tmp_path / "codegen" / "generators"
    gens.mkdir(parents=True)
    (tmp_path / "codegen" / "__init__.py").write_text("")
    (gens / "__init__.py").write_text("")
    shutil.copyfile(RECIPE, gens / "json_schema.py")
    (tmp_path / "metaobjects.config.yaml").write_text(
        "targets:\n  api:\n    outDir: gen\n    generators: "
        "[codegen.generators.json_schema:json_schema, codegen.generators.json_schema:openapi]\n"
    )
    return tmp_path


def test_model_walk_helpers_resolve_inheritance() -> None:
    root = MetaDataLoader.from_string(json.dumps(SHOP)).root
    customer = next(o for o in root.children() if o.name == "Customer")
    fields = {f.name: f for f in customer.fields()}
    # Inherited through `extends` — Python's own-only attr() would read None for these.
    assert is_required(fields["createdAt"]) is True
    assert field_is_array(fields["labels"]) is True
    assert max_length(fields["labels"]) == 40
    assert enum_values(fields["tier"]) == ["free", "paid"]
    target = object_ref_target(fields["shipping"])
    assert target is not None and target.resolution_key() == "shop::Address"


def test_recipe_generates_and_verifies(tmp_path: Path, monkeypatch) -> None:
    root = _project(tmp_path)
    monkeypatch.chdir(root)
    assert main(["gen"]) == 0

    customer = json.loads((root / "gen" / "schemas" / "shop" / "Customer.schema.json").read_text())
    props = customer["properties"]
    assert props["createdAt"] == {"type": "string", "format": "date-time"}
    assert props["labels"] == {"type": "array", "items": {"type": "string", "maxLength": 40}}
    assert props["shipping"] == {"$ref": "./Address.schema.json"}
    assert customer["required"] == ["createdAt", "email"]
    assert not (root / "gen" / "schemas" / "shop" / "BaseEntity.schema.json").exists()
    # A JSON-only output tree is not a Python package: no stray __init__.py beside it.
    assert not (root / "gen" / "schemas" / "shop" / "__init__.py").exists()

    api = json.loads((root / "gen" / "openapi.json").read_text())
    assert api["openapi"] == "3.1.0"
    assert sorted(api["paths"]) == ["/customers", "/customers/{id}"]
    assert sorted(api["components"]["schemas"]) == ["Address", "Customer"]

    assert main(["verify", "--codegen"]) == 0

    model = json.loads(json.dumps(SHOP))
    model["metadata"]["children"][2]["object.entity"]["children"].append({"field.string": {"name": "note"}})
    (root / "metaobjects" / "meta.shop.json").write_text(json.dumps(model))
    assert main(["verify", "--codegen"]) != 0
