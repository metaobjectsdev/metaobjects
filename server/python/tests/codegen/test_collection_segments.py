"""REST collection segments honour ``@collectionName`` and ``naming.collections``.

Runs every case of the shared cross-port fixture
``fixtures/naming-conformance/collection-segments.json`` through
``collection_segment_of``, plus one generated-router test that a declared
``@collectionName`` moves the mounted path.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import metaobjects.core_types  # noqa: F401 — side-effect: registers attr classes
from metaobjects import InMemoryStringSource, MetaDataLoader
from metaobjects.apidocs.naming import collection_segment, collection_segment_of
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.codegen.runtime.m2m_codegen import build_object_index
from metaobjects.meta.core.object.meta_object import MetaObject

FIXTURE = Path(__file__).parents[4] / "fixtures" / "naming-conformance" / "collection-segments.json"
CASES = json.loads(FIXTURE.read_text())["cases"]


@pytest.mark.parametrize(
    "case",
    CASES,
    ids=[f'{c["name"]}|{c.get("collectionName", "-")}|{c.get("pluralizer", "-")}' for c in CASES],
)
def test_shared_collection_segment_case(case: dict) -> None:
    assert (
        collection_segment_of(case["name"], case.get("collectionName"), case.get("pluralizer"))
        == case["segment"]
    )


def _entity(name: str, extra_attrs: dict | None = None, naming: dict | None = None) -> MetaObject:
    obj = {
        "name": name,
        "children": [
            {"source.rdb": {"@table": name.lower()}},
            {"field.string": {"name": "id"}},
            {"identity.primary": {"name": "pk", "@fields": ["id"]}},
        ],
        **(extra_attrs or {}),
    }
    root = {"metadata.root": {"package": "acme::seg", "children": [{"object.entity": obj}]}}
    res = MetaDataLoader().load([InMemoryStringSource(json.dumps(root))])
    assert res.errors == [], res.errors
    if naming is not None:
        from metaobjects.naming import NamingRules

        res.root.naming = NamingRules(**naming)  # type: ignore[attr-defined]
    return next(c for c in res.root.children() if isinstance(c, MetaObject) and c.name == name)


def test_unconfigured_object_keeps_the_historical_segment() -> None:
    assert collection_segment(_entity("PostCategory")) == "post_categories"


def test_declared_collection_name_wins() -> None:
    assert collection_segment(_entity("Faq", {"@collectionName": "FAQs"})) == "faqs"


def test_explicit_standard_pluralizer_differs_from_absent_for_analysis() -> None:
    # TS: absent -> pluralize(snake("Analysis")) = "analysises" (the legacy rule);
    # explicit "standard" -> snakeCollectionName(standard("Analysis")), computed here from
    # the same two steps TS uses.
    from metaobjects.apidocs.naming import snake_collection_name
    from metaobjects.naming import pluralizer

    expected = snake_collection_name(pluralizer("standard")("Analysis"))
    assert collection_segment(_entity("Analysis", naming={"collections": "standard"})) == expected
    assert collection_segment(_entity("Analysis")) == "analysises"


def test_configured_pluralizer_none_keeps_the_name() -> None:
    assert collection_segment(_entity("TaxID", naming={"collections": "none"})) == "tax_id"


def test_declared_collection_name_changes_the_mounted_router_path() -> None:
    plain = _entity("Box")
    declared = _entity("Box", {"@collectionName": "PDFBoxes"})
    out_plain = render_router(plain, build_object_index([plain]), api_prefix="")
    out_declared = render_router(declared, build_object_index([declared]), api_prefix="")
    assert out_plain is not None and out_declared is not None
    assert 'APIRouter(prefix="/boxes"' in out_plain
    assert 'APIRouter(prefix="/pdf_boxes"' in out_declared
