"""`api-docs` is an ordinary entry in the generator list, and a project can own it.

Since 1.1.0 (ADR-0034 Amendment 9) ``metaobjects gen`` runs ``api-docs`` like every other
entry: it is listed in a target's ``generators``, its pages land under that target's ``outDir``,
and its options are the top-level ``apiDocs`` block. An owned copy is listed in its place, as
any owned generator is. There is no ``docs`` command and no ``docs.generators`` block. What
the reference documents comes from the same ``shared_predicates`` module the owned ``routes``
and ``filter-allowlist`` read, so an edit to the owned predicate moves the router, the
allowlist and the reference together.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

from metaobjects.cli import DOCS_COMMAND_REMOVED, legacy_docs_message, main
from metaobjects.codegen.project_config import ConfigError, load_project_config

REPO = Path(__file__).parents[4]
FITNESS = REPO / "fixtures" / "persistence-conformance" / "canonical" / "meta.fitness.json"
OWNED_DOCS = "codegen.generators.api_docs:api_docs_generator"

#: The ``apiDocs`` block every project here carries: the 1.0 runs passed ``--project model``.
API_DOCS = "apiDocs:\n  projectName: model\n"


def _project(
    root: Path, extra: str = API_DOCS, generators: str = "entity", docs: str | None = "api-docs",
) -> Path:
    """A project with a ``main`` code target and, when *docs* is given, a ``docs`` target
    whose ``outDir`` is ``docs`` and whose one entry is *docs*."""
    (root / "metaobjects").mkdir(parents=True, exist_ok=True)
    (root / "metaobjects" / FITNESS.name).write_text(FITNESS.read_text(encoding="utf-8"))
    cfg = root / "metaobjects.config.yaml"
    docs_target = f"  docs:\n    outDir: docs\n    generators: [{docs}]\n" if docs else ""
    cfg.write_text(
        f"{extra}targets:\n  main:\n    outDir: gen\n    generators: [{generators}]\n{docs_target}",
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
    """Write only the documentation: ``gen`` narrowed to the ``docs`` target."""
    _forget_owned()
    monkeypatch.chdir(root)
    return main(["gen", "--target", "docs", *args])


def _pages(root: Path) -> dict[str, str]:
    base = root / "docs"
    return {p.relative_to(base).as_posix(): p.read_text(encoding="utf-8")
            for p in sorted(base.rglob("*.md"))}


# --- config -----------------------------------------------------------------------------


def test_the_api_docs_block_is_read(tmp_path: Path) -> None:
    cfg = _project(tmp_path, "apiDocs:\n  projectName: model\n  apiSubDir: ref/py\n")
    api_docs = load_project_config(cfg).api_docs
    assert api_docs is not None and (api_docs.project_name, api_docs.api_subdir) == ("model", "ref/py")
    assert load_project_config(_project(tmp_path / "plain", extra="")).api_docs is None


@pytest.mark.parametrize("block, message", [
    ("apiDocs:\n  projectName: ''\n", "non-empty string"),
    ("apiDocs:\n  layout: flat\n", "unknown key"),
    ("apiDocs: []\n", "must be a mapping"),
])
def test_a_bad_api_docs_block_is_refused_by_name(tmp_path: Path, block: str, message: str) -> None:
    with pytest.raises(ConfigError, match=message):
        load_project_config(_project(tmp_path, block))


# --- gen runs the owned copy ------------------------------------------------------------


def test_gen_runs_an_owned_api_docs_listed_in_place_of_the_packaged_one(
    tmp_path: Path, monkeypatch, capsys,
) -> None:
    _project(tmp_path, docs=OWNED_DOCS)
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "api-docs"]) == 0
    out = capsys.readouterr().out
    assert f'replace "api-docs" in `generators` with {OWNED_DOCS}' in out
    assert "docs.generators" not in out
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


def test_the_packaged_name_runs_the_packaged_generator_even_when_one_is_owned(
    tmp_path: Path, monkeypatch,
) -> None:
    """What runs is what the list names: ejecting a copy changes nothing until it is listed."""
    _project(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "api-docs"]) == 0
    renderer = tmp_path / "codegen" / "runtime" / "api_docs_renderer.py"
    renderer.write_text(renderer.read_text(encoding="utf-8").replace(
        "# Agent API Reference", "# Owned Agent API Reference"), encoding="utf-8")
    assert _docs(tmp_path, monkeypatch) == 0
    assert _pages(tmp_path)["api/python/AGENT-API.md"].startswith("# Agent API Reference")


def test_the_positional_docs_form_is_removed(tmp_path: Path, monkeypatch, capsys) -> None:
    _project(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert main(["docs", "metaobjects", "--out", "docs", "--project", "model"]) == 2
    assert capsys.readouterr().err.strip() == DOCS_COMMAND_REMOVED
    assert not (tmp_path / "docs").exists()


def test_a_1_0_docs_generators_block_is_refused_before_anything_is_written(
    tmp_path: Path, monkeypatch, capsys,
) -> None:
    """The 1.0 home of an owned api-docs. Nothing reads it in 1.1.0, so a run that kept it
    would pass while writing no documentation; gen refuses it instead, by its new home."""
    _project(tmp_path, f"docs:\n  generators: [{OWNED_DOCS}]\n", docs=None)
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "api-docs"]) == 0
    capsys.readouterr()
    assert main(["gen"]) == 2
    assert capsys.readouterr().err.strip() == legacy_docs_message("metaobjects gen")
    assert not (tmp_path / "gen").exists() and not (tmp_path / "docs").exists()


def test_two_api_docs_entries_in_one_target_are_refused(tmp_path: Path, monkeypatch, capsys) -> None:
    """Two entries writing the same pages into one outDir collide, owned or packaged."""
    _project(tmp_path, docs=f"api-docs, {OWNED_DOCS}")
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "api-docs"]) == 0
    assert _docs(tmp_path, monkeypatch) == 1
    err = capsys.readouterr().err
    assert "target 'docs'" in err and "collision" in err


# --- gen runs a docs entry like any other -----------------------------------------------


@pytest.mark.parametrize("entry", ["api-docs", OWNED_DOCS], ids=["packaged", "owned"])
def test_gen_runs_a_docs_entry_under_a_target_like_any_other(
    entry: str, tmp_path: Path, monkeypatch, capsys,
) -> None:
    """Through 1.0 ``gen`` skipped a docs generator under a target. It is an entry now: its
    pages land under that target's outDir, beside the code, and nothing is skipped."""
    _project(tmp_path, generators=f"entity, {entry}", docs=None)
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "api-docs"]) == 0
    capsys.readouterr()
    assert main(["gen"]) == 0
    assert "skipped" not in capsys.readouterr().out
    written = {p.relative_to(tmp_path / "gen").as_posix() for p in (tmp_path / "gen").rglob("*")
               if p.is_file()}
    assert "api/python/AGENT-API.md" in written and "api/python/README.md" in written
    assert "Program.py" in written


# --- the reference describes the code the owned generators emit --------------------------


def test_one_owned_predicate_moves_the_router_the_allowlist_and_the_reference(
    tmp_path: Path, monkeypatch,
) -> None:
    owned = tmp_path / "owned"
    _project(owned,
             generators="entity, codegen.generators.filter_allowlist:filter_allowlist_generator, "
                        "codegen.generators.routes:router_generator",
             docs=OWNED_DOCS)
    monkeypatch.chdir(owned)
    assert main(["eject", "api-docs", "filter-allowlist", "routes"]) == 0
    assert main(["gen"]) == 0
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
    for stale in [*(owned / "gen").glob("*"), *(owned / "docs").rglob("*")]:
        if stale.is_file():
            stale.unlink()
    _forget_owned()
    assert main(["gen"]) == 0
    after = _pages(owned)
    assert not any(f.name == "post_router.py" for f in (owned / "gen").glob("*_router.py"))
    assert not any(f.name == "post_filter_allowlist.py" for f in (owned / "gen").glob("*.py"))
    assert not any("GET /api/posts" in page for page in after.values())
    assert after != before
