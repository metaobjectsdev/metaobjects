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


def test_raises_for_route_segment_twins(tmp_path: Path) -> None:
    # ApiKey / APIKey pluralize to different names but both snake_case to /api_keys.
    with pytest.raises(ValueError) as exc_info:
        assert_no_collection_name_collisions(_entities(tmp_path, "ApiKey", "APIKey"))
    msg = str(exc_info.value)
    assert ERR_COLLECTION_NAME_COLLISION in msg
    assert '"ApiKey"' in msg and '"APIKey"' in msg and "api_keys" in msg


# fixtures/naming-conformance/'s shapeOnlyCases: an object that emits no collection (abstract,
# or with no source) claims no collection name, so a same-named emitting entity in another
# package is not a collision. crossPackageCollisionCases is the control.

def _naming_corpus() -> dict:
    return json.loads(_NAMING_CONFORMANCE_FIXTURE.read_text())


def _packaged_objects(tmp_path: Path, *objects: dict) -> list:
    """Each object in its own package (one file per package), declaring an ``id`` key."""
    meta_dir = tmp_path / "packaged"
    meta_dir.mkdir(parents=True, exist_ok=True)
    for i, o in enumerate(objects):
        node: dict = {"name": o["name"], "children": [
            *([] if o.get("source") is False
              else [{"source.rdb": {"@table": f"{o['package']}_{o['name'].lower()}"}}]),
            {"field.long": {"name": "id"}},
            {"identity.primary": {"@fields": "id"}},
        ]}
        if o.get("abstract") is True:
            node["abstract"] = True
        (meta_dir / f"meta.{i}.json").write_text(json.dumps(
            {"metadata.root": {"package": o["package"], "children": [{"object.entity": node}]}}))
    result = MetaDataLoader.from_directory(meta_dir)
    assert result.errors == [], result.errors
    return [c for c in result.root.own_children() if c.type == TYPE_OBJECT and isinstance(c, MetaObject)]


@pytest.mark.parametrize("case", _naming_corpus()["shapeOnlyCases"], ids=lambda c: c["note"])
def test_naming_conformance_an_object_that_emits_no_collection_claims_no_name(
    tmp_path: Path, case: dict
) -> None:
    objects = _packaged_objects(tmp_path, case["shapeOnly"], case["emitting"])
    # Both orders: the first-seen object owns a name, so order must not matter.
    assert_no_collection_name_collisions(objects)
    assert_no_collection_name_collisions(list(reversed(objects)))


def test_naming_conformance_two_emitting_entities_in_two_packages_still_collide(tmp_path: Path) -> None:
    for case in _naming_corpus()["crossPackageCollisionCases"]:
        objects = _packaged_objects(tmp_path / case["collidesOn"], case["entityA"], case["entityB"])
        with pytest.raises(ValueError, match=f'{ERR_COLLECTION_NAME_COLLISION}.*"{case["collidesOn"]}"'):
            assert_no_collection_name_collisions(objects)
