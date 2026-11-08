"""A flattened value object has no column of its own: each member is a column of the
owning table, named by core naming (``resolve_flattened_column_name``). The names module
carries one ``<ENTITY>_<FIELD>_<MEMBER>_COLUMN`` constant per member, beside the field's own
``_FIELD``/``_COLUMN`` pair, which is kept as it was so nothing that imports it changes.

Mirrors the C# ``NamesGenerator``, the Java/Kotlin names generators and the TypeScript
``names.ts``; the corpus test runs the shared cross-port naming fixture.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes

from metaobjects import FileSource, InMemoryStringSource, MetaDataFormat, MetaDataLoader
from metaobjects.codegen.generators.names_generator import render_names
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.naming import to_snake_case
from metaobjects.shared.base_types import TYPE_OBJECT

from tests.conformance.naming_corpus import register_corpus_strategies

REPO = Path(__file__).parents[4]
CORPUS = REPO / "fixtures" / "naming-conformance" / "physical-names"
_CASES: list[dict[str, object]] = json.loads((CORPUS / "cases.json").read_text())["cases"]
register_corpus_strategies()

_MODEL = {
    "metadata.root": {"package": "acme::ship", "children": [
        {"object.value": {"name": "Address", "children": [
            {"field.string": {"name": "street"}},
            {"field.string": {"name": "postalCode", "@column": "ZIP"}},
        ]}},
        {"object.entity": {"name": "Shipment", "children": [
            {"source.rdb": {"@table": "shipments"}},
            {"field.long": {"name": "id"}},
            {"field.object": {"name": "shipTo", "@objectRef": "Address", "@storage": "flattened"}},
            {"field.object": {"name": "payload", "@objectRef": "Address"}},
            {"identity.primary": {"@fields": ["id"], "@generation": "increment"}},
        ]}},
    ]},
}


def _object(root: MetaObject, name: str) -> MetaObject:
    return next(c for c in root.children() if c.type == TYPE_OBJECT and c.name == name)


def _load(model: dict[str, object]) -> MetaObject:
    result = MetaDataLoader().load(
        [InMemoryStringSource(json.dumps(model), format=MetaDataFormat.JSON)]
    )
    assert not result.errors, [e.message for e in result.errors]
    return result.root


def test_a_flattened_member_gets_a_column_constant_beside_its_field_constants() -> None:
    src = render_names(_object(_load(_MODEL), "Shipment"), "snake_case")

    assert 'SHIPMENT_SHIP_TO_STREET_COLUMN: Final[str] = "ship_to_street"' in src
    assert 'SHIPMENT_SHIP_TO_POSTAL_CODE_COLUMN: Final[str] = "ship_to_ZIP"' in src
    # The field's own constants are kept as they were, so nothing that imports them changes.
    assert 'SHIPMENT_SHIP_TO_FIELD: Final[str] = "shipTo"' in src
    assert 'SHIPMENT_SHIP_TO_COLUMN: Final[str] = "ship_to"' in src
    assert 'SHIPMENT_PAYLOAD_COLUMN: Final[str] = "payload"' in src
    # It names no column of the table, so it is marked deprecated: a comment, no runtime
    # warning, and only on the flattened field.
    deprecation = (
        "#: Deprecated: a flattened field has no column of its own; use the member constants,\n"
        "#: SHIPMENT_SHIP_TO_<MEMBER>_COLUMN.\n"
        'SHIPMENT_SHIP_TO_COLUMN: Final[str] = "ship_to"\n'
    )
    assert deprecation in src
    assert src.count("Deprecated") == 1
    assert '"shipTo": SHIPMENT_SHIP_TO_COLUMN,' in src
    assert '"shipTo.street": SHIPMENT_SHIP_TO_STREET_COLUMN,' in src
    assert '"shipTo.postalCode": SHIPMENT_SHIP_TO_POSTAL_CODE_COLUMN,' in src


def test_a_flattened_member_constant_colliding_with_a_field_constant_is_left_out_with_a_warning() -> None:
    model = json.loads(json.dumps(_MODEL))
    shipment = model["metadata.root"]["children"][1]["object.entity"]["children"]
    shipment[2]["field.object"]["@flattenedColumnPrefix"] = "st_"
    shipment.insert(3, {"field.string": {"name": "shipToStreet"}})
    warnings: list[str] = []
    src = render_names(_object(_load(model), "Shipment"), "snake_case", warn=warnings.append)

    # The field's constant wins; the model generates, as it did before member constants.
    assert 'SHIPMENT_SHIP_TO_STREET_COLUMN: Final[str] = "ship_to_street"' in src
    assert '"st_street"' not in src
    assert 'SHIPMENT_SHIP_TO_POSTAL_CODE_COLUMN: Final[str] = "st_ZIP"' in src
    assert any("SHIPMENT_SHIP_TO_STREET_COLUMN" in w for w in warnings)


@pytest.mark.parametrize("case", _CASES, ids=lambda c: c["name"])
def test_every_flattened_column_in_the_naming_corpus_is_a_constant(case: dict[str, object]) -> None:
    result = MetaDataLoader().load([FileSource(CORPUS / "meta.naming.json")])
    assert not result.errors, [e.message for e in result.errors]
    naming = case["naming"] or {}
    rule = naming.get("columns", "snake_case")  # type: ignore[union-attr]
    src = render_names(_object(result.root, "Shipment"), rule)
    for key, column in case["columns"].items():  # type: ignore[union-attr]
        parts = key.split(".")
        if len(parts) != 3 or parts[0] != "Shipment":
            continue
        field, member = (to_snake_case(p).upper() for p in parts[1:])
        decl = f'SHIPMENT_{field}_{member}_COLUMN: Final[str] = "{column}"'
        assert decl in src, f"{case['name']}: {decl}\n{src}"
