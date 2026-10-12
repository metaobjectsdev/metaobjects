"""`api-docs` is a generator `metaobjects docs` runs, and a project can own it.

An owned copy is listed under ``docs.generators`` in ``metaobjects.config.yaml`` and ``docs``
runs it in place of the packaged one. ``gen`` never runs a docs generator: it skips one found
under a target and says so. What the reference documents comes from the same
``shared_predicates`` module the owned ``routes`` and ``filter-allowlist`` read, so an edit
to the owned predicate moves the router, the allowlist and the reference together.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

from metaobjects.cli import main
from metaobjects.codegen.project_config import ConfigError, load_project_config

REPO = Path(__file__).parents[4]
FITNESS = REPO / "fixtures" / "persistence-conformance" / "canonical" / "meta.fitness.json"
OWNED_DOCS = "codegen.generators.api_docs:api_docs_generator"


def _project(root: Path, extra: str = "", generators: str = "entity") -> Path:
    (root / "metaobjects").mkdir(parents=True, exist_ok=True)
    (root / "metaobjects" / FITNESS.name).write_text(FITNESS.read_text(encoding="utf-8"))
    cfg = root / "metaobjects.config.yaml"
    cfg.write_text(
        f"targets:\n  main:\n    outDir: gen\n    generators: [{generators}]\n{extra}",
        encoding="utf-8",
    )
    return cfg


@pytest.fixture(autouse=True)
def _fresh_owned_modules():
    """A real run is a fresh process; here one process runs several projects, and an edit to
    an owned module must be seen by the next run, so each run starts with no `codegen` loaded."""
    _forget_owned()
    yield
    _forget_owned()


def _forget_owned() -> None:
    for name in [k for k in sys.modules if k == "codegen" or k.startswith("codegen.")]:
        del sys.modules[name]


def _docs(root: Path, monkeypatch, *args: str) -> int:
    _forget_owned()
    monkeypatch.chdir(root)
    return main(["docs", "--out", "docs", "--project", "model", *args])


def _pages(root: Path) -> dict[str, str]:
    base = root / "docs"
    return {p.relative_to(base).as_posix(): p.read_text(encoding="utf-8")
            for p in sorted(base.rglob("*.md"))}


# --- config -----------------------------------------------------------------------------


def test_the_docs_block_is_read(tmp_path: Path) -> None:
    cfg = _project(tmp_path, f"docs:\n  generators: [{OWNED_DOCS}]\n")
    assert load_project_config(cfg).docs_generators == [OWNED_DOCS]
    assert load_project_config(_project(tmp_path / "plain")).docs_generators == []


@pytest.mark.parametrize("block, message", [
    ("docs:\n  generators: [api-docs]\n", "module:symbol"),
    ("docs:\n  generators: nope\n", "list of strings"),
    ("docs:\n  generator: [a:b]\n", "unknown key"),
    ("docs: []\n", "must be a mapping"),
])
def test_a_bad_docs_block_is_refused_by_name(tmp_path: Path, block: str, message: str) -> None:
    with pytest.raises(ConfigError, match=message):
        load_project_config(_project(tmp_path, block))


# --- docs runs the owned copy -----------------------------------------------------------


def test_docs_runs_an_owned_api_docs_in_place_of_the_packaged_one(tmp_path: Path, monkeypatch, capsys) -> None:
    _project(tmp_path, f"docs:\n  generators: [{OWNED_DOCS}]\n")
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "api-docs"]) == 0
    out = capsys.readouterr().out
    assert "docs.generators" in out and OWNED_DOCS in out and "`gen` never does" in out
    assert _docs(tmp_path, monkeypatch) == 0
    owned_pages = _pages(tmp_path)

    packaged = tmp_path / "packaged"
    _project(packaged)
    assert _docs(packaged, monkeypatch) == 0
    # Unchanged, the copy writes what the packaged generator writes.
    assert owned_pages == _pages(packaged) and owned_pages

    # An edit to the owned renderer reaches the page: the copy, not the package, ran.
    renderer = tmp_path / "codegen" / "runtime" / "api_docs_renderer.py"
    source = renderer.read_text(encoding="utf-8")
    assert source.count("# Agent API Reference") == 1
    renderer.write_text(source.replace("# Agent API Reference", "# Owned Agent API Reference"),
                        encoding="utf-8")
    assert _docs(tmp_path, monkeypatch) == 0
    assert _pages(tmp_path)["api/python/AGENT-API.md"].startswith("# Owned Agent API Reference")


def test_docs_without_a_docs_block_runs_the_packaged_generator_even_when_one_is_owned(
    tmp_path: Path, monkeypatch,
) -> None:
    _project(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "api-docs"]) == 0
    renderer = tmp_path / "codegen" / "runtime" / "api_docs_renderer.py"
    renderer.write_text(renderer.read_text(encoding="utf-8").replace(
        "# Agent API Reference", "# Owned Agent API Reference"), encoding="utf-8")
    assert _docs(tmp_path, monkeypatch) == 0
    assert _pages(tmp_path)["api/python/AGENT-API.md"].startswith("# Agent API Reference")


def test_the_positional_docs_form_reads_no_config(tmp_path: Path, monkeypatch) -> None:
    _project(tmp_path, f"docs:\n  generators: [{OWNED_DOCS}]\n")
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "api-docs"]) == 0
    renderer = tmp_path / "codegen" / "runtime" / "api_docs_renderer.py"
    renderer.write_text(renderer.read_text(encoding="utf-8").replace(
        "# Agent API Reference", "# Owned Agent API Reference"), encoding="utf-8")
    assert _docs(tmp_path, monkeypatch, "metaobjects") == 0
    assert _pages(tmp_path)["api/python/AGENT-API.md"].startswith("# Agent API Reference")


def test_a_docs_entry_that_is_not_a_docs_generator_is_refused_by_name(
    tmp_path: Path, monkeypatch, capsys,
) -> None:
    _project(tmp_path, "docs:\n  generators: [codegen.generators.entity:entity_model]\n")
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "entity"]) == 0
    assert _docs(tmp_path, monkeypatch) == 1
    err = capsys.readouterr().err
    assert "codegen.generators.entity:entity_model" in err and "not a docs generator" in err
    assert not (tmp_path / "docs").exists()


def test_two_owned_generators_for_the_api_surface_are_refused(tmp_path: Path, monkeypatch, capsys) -> None:
    _project(tmp_path, f"docs:\n  generators: [{OWNED_DOCS}, {OWNED_DOCS}]\n")
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "api-docs"]) == 0
    assert _docs(tmp_path, monkeypatch) == 1
    assert "two generators for the 'api' surface" in capsys.readouterr().err


# --- gen leaves a docs generator out ----------------------------------------------------


@pytest.mark.parametrize("entry, remedy, not_the_remedy", [
    ("api-docs", "`metaobjects docs` already runs it, so remove the entry.", "docs.generators"),
    (OWNED_DOCS, "List it under `docs.generators` in metaobjects.config.yaml", "already runs it"),
], ids=["packaged", "owned"])
def test_gen_skips_a_docs_generator_under_a_target_and_says_so(
    entry: str, remedy: str, not_the_remedy: str, tmp_path: Path, monkeypatch, capsys,
) -> None:
    """The packaged name cannot go under ``docs.generators`` (that block takes owned copies
    only), so the warning sends each kind of entry where it can actually go."""
    _project(tmp_path, generators=f"entity, {entry}")
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "api-docs"]) == 0
    capsys.readouterr()
    assert main(["gen"]) == 0
    skipped = [ln for ln in capsys.readouterr().out.splitlines() if "so gen skipped it" in ln]
    assert len(skipped) == 1
    assert "warning: 'api-docs' writes the api reference, so gen skipped it" in skipped[0]
    assert remedy in skipped[0] and not_the_remedy not in skipped[0]
    written = {p.relative_to(tmp_path / "gen").as_posix() for p in (tmp_path / "gen").rglob("*")
               if p.is_file()}
    assert written and not any(w.startswith("api/") or w.endswith("AGENT-API.md") for w in written)
    assert not (tmp_path / "gen" / "api").exists()


# --- the reference describes the code the owned generators emit --------------------------


def test_one_owned_predicate_moves_the_router_the_allowlist_and_the_reference(
    tmp_path: Path, monkeypatch,
) -> None:
    owned = tmp_path / "owned"
    _project(owned, f"docs:\n  generators: [{OWNED_DOCS}]\n",
             generators="entity, codegen.generators.filter_allowlist:filter_allowlist_generator, "
                        "codegen.generators.routes:router_generator")
    monkeypatch.chdir(owned)
    assert main(["eject", "api-docs", "filter-allowlist", "routes"]) == 0
    assert main(["gen"]) == 0
    assert _docs(owned, monkeypatch) == 0
    before = _pages(owned)
    assert any(f.name == "post_router.py" for f in (owned / "gen").glob("*_router.py"))
    assert any("GET /api/posts" in page for page in before.values())

    rule = owned / "codegen" / "runtime" / "shared_predicates.py"
    rule.write_text(
        rule.read_text(encoding="utf-8")
        + "\n\n_reference_emits_router = emits_router\n\n\n"
        "def emits_router(entity):\n"
        "    return entity.name != 'Post' and _reference_emits_router(entity)\n",
        encoding="utf-8",
    )
    for stale in (owned / "gen").glob("*"):
        if stale.is_file():
            stale.unlink()
    _forget_owned()
    assert main(["gen"]) == 0
    assert _docs(owned, monkeypatch) == 0
    after = _pages(owned)
    assert not any(f.name == "post_router.py" for f in (owned / "gen").glob("*_router.py"))
    assert not any(f.name == "post_filter_allowlist.py" for f in (owned / "gen").glob("*.py"))
    assert not any("GET /api/posts" in page for page in after.values())
    assert after != before
