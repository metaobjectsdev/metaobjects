"""assert_no_collection_name_collisions — the single choke point every route/router
generator path goes through (called once, in run_gen, over the full entity set
BEFORE any generator runs). See collection_name_collision.py's module docstring.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects import MetaDataLoader
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT
from metaobjects.codegen.collection_name_collision import (
    ERR_COLLECTION_NAME_COLLISION,
    assert_no_collection_name_collisions,
)

_NAMING_CONFORMANCE_FIXTURE = (
    Path(__file__).parents[4] / "fixtures" / "naming-conformance" / "already-plural-pluralize.json"
)


def _entities(tmp_path: Path, *names: str) -> list:
    children = [
        {
            "object.entity": {
                "name": name,
                "children": [
                    {"source.rdb": {"@table": name.lower()}},
                    {"field.long": {"name": "id"}},
                    {"identity.primary": {"@fields": "id"}},
                ],
            }
        }
        for name in names
    ]
    meta_dir = tmp_path / "meta"
    meta_dir.mkdir(parents=True, exist_ok=True)
    (meta_dir / "meta.json").write_text(
        json.dumps({"metadata.root": {"package": "acme", "children": children}})
    )
    root = MetaDataLoader.from_directory(meta_dir).root
    return [c for c in root.own_children() if c.type == TYPE_OBJECT and isinstance(c, MetaObject)]


def _entity_and_value(tmp_path: Path, entity_name: str, value_name: str) -> list:
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": entity_name,
                        "children": [
                            {"source.rdb": {"@table": entity_name.lower()}},
                            {"field.long": {"name": "id"}},
                            {"identity.primary": {"@fields": "id"}},
                        ],
                    }
                },
                {
                    "object.value": {
                        "name": value_name,
                        "children": [{"field.string": {"name": "text"}}],
                    }
                },
            ],
        }
    }
    meta_dir = tmp_path / "meta"
    meta_dir.mkdir(parents=True, exist_ok=True)
    (meta_dir / "meta.json").write_text(json.dumps(doc))
    root = MetaDataLoader.from_directory(meta_dir).root
    return [c for c in root.own_children() if c.type == TYPE_OBJECT and isinstance(c, MetaObject)]


def test_does_not_raise_for_distinct_plurals(tmp_path: Path) -> None:
    assert_no_collection_name_collisions(_entities(tmp_path, "Post", "Author", "Category"))


def test_raises_for_address_and_addresses(tmp_path: Path) -> None:
    with pytest.raises(ValueError) as exc_info:
        assert_no_collection_name_collisions(_entities(tmp_path, "Address", "Addresses"))
    msg = str(exc_info.value)
    assert ERR_COLLECTION_NAME_COLLISION in msg
    assert "Address" in msg
    assert "Addresses" in msg


def test_raises_for_order_and_orders(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        assert_no_collection_name_collisions(_entities(tmp_path, "Order", "Orders"))


def test_excludes_value_objects(tmp_path: Path) -> None:
    # "Address" (entity) pluralizes to "Addresses"; an unrelated object.value named
    # "Addresses" never gets a route, so it must not trip this.
    assert_no_collection_name_collisions(_entity_and_value(tmp_path, "Address", "Addresses"))


def test_naming_conformance_collision_cases_are_refused(tmp_path: Path) -> None:
    cases = json.loads(_NAMING_CONFORMANCE_FIXTURE.read_text())["collisionCases"]
    for i, case in enumerate(cases):
        with pytest.raises(ValueError):
            assert_no_collection_name_collisions(
                _entities(tmp_path / str(i), case["entityA"], case["entityB"])
            )
