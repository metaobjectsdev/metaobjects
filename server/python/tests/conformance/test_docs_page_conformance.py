"""Cross-port docs-page corpus: fixtures/docs-page-conformance/.

The requirements page, the agent requirements page and the MODEL-ONLY agent schema page are
shared Mustache templates fed data a per-port builder computes. TypeScript is the source of
the expected bytes; this runner holds the Python builders to them in three layers, so a
failure says where it is: the ROWS each builder starts from (JSON value equality), the PAGE
DATA each template is fed (JSON value equality), then the BYTES. The SET of pages is pinned
too: a page the case does not list must not be written.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from metaobjects import MetaDataLoader
from metaobjects.codegen.generator import GenContext
from metaobjects.codegen.generators.agent_docs_generator import AgentDocsGenerator
from metaobjects.codegen.generators.requirements_generator import RequirementsGenerator
from metaobjects.codegen.runtime.docs_requirements import (
    REQUIREMENTS_PAGE_REF,
    REQUIREMENTS_TOON_REF,
    agent_requirements_page_data,
    requirement_rows,
    requirements_ledger_data,
    requirements_toon_data,
    toon_cell,
)
from metaobjects.codegen.runtime.docs_schema import agent_schema_page_data, schema_rows
from metaobjects.config.neutral_config import chose_migrate_dialect
from metaobjects.render.doc_pages import doc_provider, render_doc_page


def _corpus() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "fixtures" / "docs-page-conformance" / "cases"
        if candidate.is_dir():
            return candidate
    raise RuntimeError("could not locate fixtures/docs-page-conformance")


CORPUS = _corpus()
CASES = sorted(p.name for p in CORPUS.iterdir() if p.is_dir())


def _load(case: str):
    from metaobjects.loader.sources import FileSource

    files = sorted((CORPUS / case / "input").glob("meta.*.json"))
    result = MetaDataLoader(strict=True).load([FileSource(p) for p in files])
    assert not result.errors, result.errors
    return result.root


def _expected(case: str) -> dict[str, str]:
    base = CORPUS / case / "expected"
    return {p.relative_to(base).as_posix(): p.read_text(encoding="utf-8") for p in base.rglob("*") if p.is_file()}


def _json(expected: dict[str, str], path: str) -> Any:
    return json.loads(expected[path])


def _ctx(root, project_root: Path) -> GenContext:
    from metaobjects.codegen.config import GenConfig

    config = GenConfig(out_dir="out", project_root=str(project_root))
    return GenContext(entities=[], loaded_root=root, matches=lambda _e: True, config=config, warn=lambda _m: None)


def test_the_corpus_is_not_empty() -> None:
    assert CASES


@pytest.mark.parametrize("case", CASES)
def test_rows_data_and_bytes(case: str) -> None:
    root = _load(case)
    expected = _expected(case)
    provider = doc_provider()

    rows = requirement_rows(root)
    if rows:
        assert rows == _json(expected, "rows/requirements.json"), "requirement rows"
        assert requirements_ledger_data(rows) == _json(expected, "data/requirements.md.json")
        assert requirements_toon_data(rows) == _json(expected, "data/requirements.toon.json")
        assert (
            render_doc_page(REQUIREMENTS_PAGE_REF, requirements_ledger_data(rows), provider, "requirements.md")
            == expected["requirements.md"]
        )
        assert (
            render_doc_page(REQUIREMENTS_TOON_REF, requirements_toon_data(rows), provider, "requirements.toon")
            == expected["requirements.toon"]
        )

    def ledger(data: dict[str, Any]) -> str:
        return render_doc_page(REQUIREMENTS_PAGE_REF, data, provider, "requirements.md")

    agent = agent_requirements_page_data(root, None, ledger)
    if agent is not None:
        assert agent == _json(expected, "data/agent-requirements.md.json"), "agent requirements data"

    srows = schema_rows(root)
    data = agent_schema_page_data(root, srows, chose_migrate_dialect(CORPUS / case / "input"))
    if data is not None:
        assert srows == _json(expected, "rows/schema.json"), "schema rows"
        assert data == _json(expected, "data/agent-schema.md.json"), "schema page data"

    # The generators write exactly the pinned pages, byte for byte (the set is pinned too).
    ctx = _ctx(root, CORPUS / case / "input")
    written = {f.path: f.content for f in RequirementsGenerator().generate(ctx)}
    written.update({f.path: f.content for f in AgentDocsGenerator().generate(ctx)})
    pages = {k: v for k, v in expected.items() if not k.startswith(("data/", "rows/"))}
    assert sorted(written) == sorted(pages)
    for path, content in pages.items():
        assert written[path] == content, path


@pytest.mark.parametrize(
    ("value", "cell"),
    [
        (4, "4"),
        ("plain words", "plain words"),
        ("", '""'),
        ("true", '"true"'),
        ("12", '"12"'),
        ("007", '"007"'),
        ("a, b", '"a, b"'),
        ("a: b", '"a: b"'),
        ("-x", '"-x"'),
        (" padded", '" padded"'),
        ("line\nbreak", '"line\\nbreak"'),
        ("tab\there", '"tab\\there"'),
        ("bell\x07", '"bell\\u0007"'),
        ('q"uote', '"q\\"uote"'),
    ],
)
def test_toon_cell_quoting(value: str | int, cell: str) -> None:
    assert toon_cell(value) == cell


def test_a_project_template_overrides_the_bundled_page(tmp_path: Path) -> None:
    root = _load("ledger-unclaimed")
    override = tmp_path / "requirements"
    override.mkdir()
    (override / "requirements.toon.mustache").write_text("custom {{{count}}}", encoding="utf-8")
    files = {f.path: f.content for f in RequirementsGenerator(template_root=str(tmp_path)).generate(_ctx(root, CORPUS / "ledger-unclaimed" / "input"))}
    assert files["requirements.toon"] == "custom 1"
    assert files["requirements.md"].startswith("# Requirements")
