"""Each API page lands under its own object's package, not the first loaded file's.

A model loaded from several files has one root; ``root.package`` is the first file's. The
builder used to read the package off the node and then its ancestors, so every object whose
own file declared another package was filed (and back-linked) under the root's.
"""
from __future__ import annotations

import tempfile
from pathlib import Path

from metaobjects import MetaDataLoader
from metaobjects.apidocs import PythonApiModelBuilder
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator import GenContext
from metaobjects.codegen.generators.api_docs_generator import ApiDocsGenerator
from metaobjects.shared.base_types import TYPE_OBJECT


def _entity_file(package: str, name: str) -> str:
    return (
        '{ "metadata.root": { "package": "%s", "children": [\n'
        '  { "object.entity": { "name": "%s", "children": [\n'
        '    { "source.rdb": { "@table": "t_%s" } },\n'
        '    { "field.long": { "name": "id" } },\n'
        '    { "identity.primary": { "name": "id", "@fields": ["id"], "@generation": "increment" } }\n'
        "  ]}}\n"
        "]}}" % (package, name, name.lower())
    )


def _load_two_packages():
    with tempfile.TemporaryDirectory() as d:
        # Sorted load order makes "alpha" the file whose package the merged root keeps.
        (Path(d) / "meta.alpha.json").write_text(_entity_file("alpha::lib", "Widget"), encoding="utf-8")
        (Path(d) / "meta.beta.json").write_text(_entity_file("beta::app", "Order"), encoding="utf-8")
        r = MetaDataLoader.from_directory(d)
    assert not r.errors, r.errors
    return r.root


def test_every_unit_carries_its_own_package() -> None:
    model = PythonApiModelBuilder().build(_load_two_packages(), "two-packages")
    assert {u.node: u.package for u in model.units} == {"Widget": "alpha::lib", "Order": "beta::app"}


def test_pages_and_back_links_are_filed_under_each_package() -> None:
    root = _load_two_packages()
    ctx = GenContext(
        entities=[c for c in root.own_children() if c.type == TYPE_OBJECT],
        loaded_root=root,
        matches=lambda _e: True,
        config=GenConfig(out_dir="/tmp/out"),
        warn=lambda _m: None,
    )
    files = {f.path: f.content for f in ApiDocsGenerator(api_subdir="api", model_base_url="https://docs.example.test").generate(ctx)}

    assert "api/alpha/lib/Widget.md" in files
    assert "api/beta/app/Order.md" in files
    assert not [p for p in files if p.endswith("Order.md") and "alpha" in p], sorted(files)
    # The back-link to the model page stays in the page's own package.
    # (The link is emitted only when `modelBaseUrl` says where the model pages live.)
    assert "https://docs.example.test/alpha/lib/Widget.md" in files["api/alpha/lib/Widget.md"]
    assert "https://docs.example.test/beta/app/Order.md" in files["api/beta/app/Order.md"]
    assert "alpha" not in files["api/beta/app/Order.md"]
