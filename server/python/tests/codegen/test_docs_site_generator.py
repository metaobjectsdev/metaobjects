"""The ``docs-site`` generator (the model explorer): the same files, and the same data script
bytes, as TypeScript's ``generateExplorerSite`` (``output: "app"``), written with no Node."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
from pathlib import Path

import pytest

from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator import EmittedFile, GenContext
from metaobjects.codegen.generator_registry import GENERATOR_REGISTRY, GeneratorBuildContext
from metaobjects.codegen.generators.docs_site_generator import (
    APP_FILES,
    DocsSiteGenerator,
    emit_site,
    read_prompt_texts,
)
from metaobjects.codegen.overwrite_policy import HASHES_FILE
from metaobjects.codegen.runner import run_gen
from metaobjects.docs_view import explorer_model_script, explorer_stamp_script

from tests.docs_view_support import corpus, fixtures, load_case


def repo() -> Path:
    for p in Path(__file__).resolve().parents:
        if (p / "fixtures" / "explorer-conformance").is_dir() and (p / "explorer-app").is_dir():
            return p
    raise RuntimeError("repository root not found")


def expected_view(name: str) -> dict:
    return json.loads((corpus() / name / "expected.json").read_text(encoding="utf-8"))


def test_registry_entry() -> None:
    entry = GENERATOR_REGISTRY["docs-site"]
    assert (entry.tier, entry.layer, entry.source) == ("neutral", "docs", None)
    assert entry.factory(GeneratorBuildContext()).name == "docs-site"  # type: ignore[attr-defined]


def test_model_script_is_typescripts_bytes() -> None:
    # explorerModelScript({ title: "Shop  <x>", footer: "v1", texts, templates, view }) in
    # @metaobjectsdev/docs-site (run with bun over fixtures/explorer-conformance/shop/expected.json)
    # gives this stamp and these bytes.
    script, stamp = explorer_model_script(
        "Shop  <x>", "v1", {"b": "B\n", "a": "A é"}, {"explorer-head.mustache": "<h>"}, expected_view("shop")
    )
    assert stamp == "2600a8bb3cb5d29d"
    assert len(script) == 50657
    assert hashlib.sha256(script.encode("utf-8")).hexdigest() == "87643095df7b9c679871c21420f8a3ae71128ba60f71f97b2b8bc99dfc482cfb"
    assert explorer_stamp_script(stamp) == 'window.MO_STAMP = "2600a8bb3cb5d29d";\n'


def test_app_files_are_the_canonical_copy() -> None:
    files = emit_site(expected_view("model-alone"), "t", "", {}, None, None)
    for f in APP_FILES:
        assert files[f] == (repo() / "explorer-app" / f).read_text(encoding="utf-8"), f
    assert files["explorer.json"] == (corpus() / "model-alone" / "expected.json").read_text(encoding="utf-8")
    assert list(files) == [
        "index.html", "assets/explorer-app.js", "assets/cytoscape.min.js", "assets/3d-force-graph.min.js",
        "assets/explorer.css", "assets/explorer.js", "explorer-model.js", "explorer-stamp.js", "explorer.json",
    ]


def test_an_owned_theme_and_template_win(tmp_path: Path) -> None:
    (tmp_path / "assets").mkdir()
    (tmp_path / "templates").mkdir()
    (tmp_path / "assets/explorer.css").write_text("body{}")
    (tmp_path / "templates/explorer-head.mustache").write_text("<owned>")
    (tmp_path / "templates/not-a-template.mustache").write_text("ignored")
    files = emit_site(expected_view("model-alone"), "t", "", {}, tmp_path / "assets", tmp_path / "templates")
    assert files["assets/explorer.css"] == "body{}"
    assert files["assets/explorer.js"] == (repo() / "explorer-app/assets/explorer.js").read_text(encoding="utf-8")
    assert '"templates":{"explorer-head.mustache":"<owned>"}' in files["explorer-model.js"]


def test_prompt_texts_read_below_the_directories_only(tmp_path: Path) -> None:
    view = expected_view("shop")
    prompts = corpus() / "shop/project/prompts"
    texts = read_prompt_texts(view, [tmp_path, prompts])
    assert len(texts) == 1
    assert next(iter(texts.values())) == (prompts / "shop/order-note.mustache").read_text(encoding="utf-8")
    climbing = json.loads(json.dumps(view).replace('"shop/order-note"', '"../order-note"'))
    assert read_prompt_texts(climbing, [prompts / "shop"]) == {}


def _run(name: str, tmp_path: Path, extra: list | None = None, **options: str) -> dict[str, str]:
    case = corpus() / name
    gen_state = tmp_path / "gen-state"
    gen_state.mkdir()
    if (case / "hashes.json").is_file():
        shutil.copy(case / "hashes.json", gen_state / HASHES_FILE)
    sink: dict[str, str] = {}
    config = GenConfig(
        out_dir=str(case / "project" / "gen"), project_root=str(case / "project"),
        gen_state_dir=str(gen_state), sink=sink,
    )
    if (case / "verify.json").is_file():
        options.setdefault("verify_file", "../verify.json")
    if (case / "routes.json").is_file():
        options.setdefault("routes_file", "../routes.json")
    run_gen(config, load_case(name), generators=[DocsSiteGenerator(**options), *(extra or [])])
    prefix = str(case / "project" / "gen") + os.sep
    return {k[len(prefix):]: v for k, v in sink.items() if k.startswith(prefix)}


@pytest.mark.parametrize("name", fixtures())
def test_generator_writes_every_corpus_case_byte_for_byte(name: str, tmp_path: Path) -> None:
    out = _run(name, tmp_path)
    assert out["site/explorer.json"] == (corpus() / name / "expected.json").read_text(encoding="utf-8")
    model = out["site/explorer-model.js"]
    assert model.startswith('window.MO_MODEL = {"stamp":')
    assert '"title":"project"' in model
    for f in APP_FILES:
        assert "site/" + f in out


def test_generator_lists_this_runs_files_after_every_other_generator(tmp_path: Path) -> None:
    key = next(c for c in load_case("model-alone").children() if c.name == "Book").resolution_key()

    class Stub:
        name = "stub"

        def generate(self, ctx: GenContext) -> list[EmittedFile]:
            return [EmittedFile("stub/book.txt", "x", source_node=key)]

    # Declared AFTER docs-site on purpose: the runner still runs docs-site last.
    out = _run("model-alone", tmp_path, extra=[Stub()])
    view = json.loads(out["site/explorer.json"])
    assert view["sources"]["files"] is True
    book = next(n for n in view["nodes"] if n["name"] == "Book")
    assert book["files"] == [{"generatedBy": "stub", "paths": ["gen/stub/book.txt"]}]


def test_generator_falls_back_to_the_committed_manifest(tmp_path: Path) -> None:
    out = _run("shop", tmp_path)
    order = next(n for n in json.loads(out["site/explorer.json"])["nodes"] if n["name"] == "Order")
    assert any(g["generatedBy"] == "queries" for g in order["files"])
