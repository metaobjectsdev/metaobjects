"""Cross-port metamodel-docs corpus: fixtures/metamodel-docs/.

The metamodel reference pages are shared Mustache templates fed data the Python builder computes
from its registry vocabulary manifest and embedded provider definitions. TypeScript is the source
of the expected bytes; this holds the builder to the pinned page DATA (JSON value equality), then
the rendered BYTES, and pins the SET of pages.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator import GenContext
from metaobjects.codegen.generators.metamodel_docs_generator import MetamodelDocsGenerator
from metaobjects.codegen.runtime.docs_metamodel import embedded_definitions, metamodel_docs_pages
from metaobjects.core_types import core_providers
from metaobjects.provider import compose_registry
from metaobjects.registry_manifest import build_registry_manifest
from metaobjects.render.doc_pages import BUNDLED_TEMPLATES_DIR, doc_provider, render_doc_page


def _corpus() -> Path:
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "fixtures" / "metamodel-docs"
        if candidate.is_dir():
            return candidate
    raise RuntimeError("fixtures/metamodel-docs not found")


CORPUS = _corpus()
EXPECTED = CORPUS / "expected"
DATA = CORPUS / "data"
EXPECTED_PAGES = sorted(p.relative_to(EXPECTED).as_posix() for p in EXPECTED.rglob("*") if p.is_file())


def _pages():
    manifest = build_registry_manifest(compose_registry(core_providers))
    descriptions = json.loads((BUNDLED_TEMPLATES_DIR / "metamodel" / "provider-descriptions.json").read_text(encoding="utf-8"))
    return metamodel_docs_pages(manifest, embedded_definitions(), descriptions)


def _ctx() -> GenContext:
    return GenContext(entities=[], loaded_root=None, matches=lambda _o: True, config=GenConfig(out_dir="."), warn=lambda _m: None)


def test_the_page_set_is_the_expected_set() -> None:
    assert sorted(p.path for p in _pages()) == EXPECTED_PAGES


@pytest.mark.parametrize("path", EXPECTED_PAGES)
def test_page_data_equals_the_pinned_data(path: str) -> None:
    page = next(p for p in _pages() if p.path == path)
    pinned = json.loads((DATA / (path + ".json")).read_text(encoding="utf-8"))
    assert page.data == pinned


@pytest.mark.parametrize("path", EXPECTED_PAGES)
def test_rendered_page_equals_the_expected_bytes(path: str) -> None:
    page = next(p for p in _pages() if p.path == path)
    rendered = render_doc_page(page.template, page.data, doc_provider(), path)
    assert rendered == (EXPECTED / path).read_text(encoding="utf-8")


def test_the_generator_writes_every_page_under_metamodel() -> None:
    files = MetamodelDocsGenerator().generate(_ctx())
    assert {f.path: f.content for f in files} == {
        f"metamodel/{p}": (EXPECTED / p).read_text(encoding="utf-8") for p in EXPECTED_PAGES
    }


def test_the_sub_dir_option_moves_the_pages() -> None:
    files = MetamodelDocsGenerator(sub_dir="ref/mm").generate(
        _ctx())
    assert {f.path for f in files} == {f"ref/mm/{p}" for p in EXPECTED_PAGES}
