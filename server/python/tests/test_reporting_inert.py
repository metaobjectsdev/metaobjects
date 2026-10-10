"""FR-044 — the reporting vocabulary is INERT in every Python generator, except for the one
report Plan 3 serves.

Plan 1 registers ``dimension.*``, ``measure.*``, ``segment.*`` and ``object.report`` and
validates them at load. A model that USES the vocabulary must generate exactly what the
same model without it generates, byte for byte, through every registered generator, with
ONE exception: a report that declares a read-only ``source.rdb @kind: view`` is SERVED
(Plan 3, Table A) and gains exactly the files below, all for ``StoreTotals``. The other three
reports (``DailyRevenue``, ``ProgramEngagement`` and ``ProgramCatalogue``, which declares
``@spine`` and lists a dimension reached by ``@via``) declare no view and generate nothing,
and a measure ``@default`` (``avgDaysPerStarter``) changes nothing either.

The model pair is ``fixtures/codegen-noop/reporting/{with,without}``, shared with the other
four ports' copies of this test. ``with/`` carries a report that declares a read-only
``source.rdb @kind: view`` (R5 allows one) — the shape that leaked in C#. Here the
``entity`` generator used to write an empty ``BaseModel`` module per report.

Runs through ``run_gen`` — the path ``metaobjects gen`` takes — because the choice lives at
its entity-set choke point.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from metaobjects import load_uris
from metaobjects.apidocs.builder import PythonApiModelBuilder
from metaobjects.apidocs.paths import Layout, doc_page_output_path
from metaobjects.apidocs.renderer import render_agent_api, render_index, render_unit_page
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator import Generator
from metaobjects.codegen.generator_registry import (
    GeneratorBuildContext,
    GeneratorEntry,
    list_generators,
)
from metaobjects.codegen.runner import run_gen
from metaobjects.meta.core.object.object_constants import OBJECT_SUBTYPE_REPORT
from metaobjects.meta.core.reporting.meta_measure import MetaMeasure
from metaobjects.meta.core.reporting.report_accessors import report_spine
from metaobjects.shared.base_types import TYPE_MEASURE, TYPE_OBJECT

MODELS = Path(__file__).parents[3] / "fixtures" / "codegen-noop" / "reporting"
THREW = "<threw>"

#: What a served report adds, by generator (Table E: row model, allowlist, names, router).
#: Every other generator emits the same files with and without the vocabulary.
SERVED_REPORT_FILES: dict[str, list[str]] = {
    "entity": ["StoreTotals.py"],
    "filter-allowlist": ["store_totals_filter_allowlist.py"],
    "names": ["store_totals_names.py"],
    "routes": ["store_totals_router.py"],
}


def _load(variant: str):
    result = load_uris([(MODELS / variant / "meta.shop.json").as_uri()])
    assert not result.errors, "\n".join(e.message for e in result.errors)
    return result.root


def _objects(variant: str) -> list:
    # ADR-0039: resolving — the root is never extended, so children() == own_children().
    return [c for c in _load(variant).children() if c.type == TYPE_OBJECT]


def _build(entry: GeneratorEntry, template_root: Path) -> Generator:
    return entry.factory(GeneratorBuildContext(template_root=str(template_root)))


def _emit(variant: str, entries: list[GeneratorEntry], tmp: Path) -> dict[str, str]:
    """Run a generator suite into a fresh directory and read back every file it wrote.

    A throw is recorded as the single entry ``<threw>``, so a generator that cannot run
    from a bare model must at least fail identically.
    """
    out = tmp / f"out-{variant}"
    templates = tmp / "templates"
    templates.mkdir(parents=True, exist_ok=True)
    try:
        run_gen(
            GenConfig(out_dir=str(out)),
            _load(variant),
            generators=[_build(e, templates) for e in entries],
        )
    except Exception as exc:  # noqa: BLE001 — a throw is compared, not swallowed
        return {THREW: str(exc)}
    if not out.exists():
        return {}
    return {
        str(p.relative_to(out)): p.read_text(encoding="utf-8")
        for p in sorted(out.rglob("*"))
        if p.is_file()
    }


def test_the_with_model_really_carries_the_vocabulary() -> None:
    # Else every comparison below is vacuously green.
    reports = sorted(o.name for o in _objects("with") if o.sub_type == OBJECT_SUBTYPE_REPORT)
    assert reports == ["DailyRevenue", "ProgramCatalogue", "ProgramEngagement", "StoreTotals"]
    with_objects = {o.name: o for o in _objects("with")}
    assert report_spine(with_objects["ProgramCatalogue"]) is not None
    # ADR-0039: resolving children() — the measure is the event entity's own member.
    defaulted = [
        m for o in with_objects.values() for m in o.children()
        if m.type == TYPE_MEASURE and isinstance(m, MetaMeasure) and m.default_value() is not None
    ]
    assert [m.name for m in defaulted] == ["avgDaysPerStarter"]
    assert not any(o.sub_type == OBJECT_SUBTYPE_REPORT for o in _objects("without"))


@pytest.mark.parametrize("entry", list_generators(), ids=lambda e: e.name)
def test_generator_emits_the_same_files_with_and_without_reporting_nodes(
    entry: GeneratorEntry, tmp_path: Path
) -> None:
    expected = _emit("without", [entry], tmp_path / "a")
    actual = _emit("with", [entry], tmp_path / "b")
    added = SERVED_REPORT_FILES.get(entry.name, [])
    # Nothing that exists without the vocabulary changes by a byte; the served report
    # adds exactly its own files, and only for the generators Table E names.
    assert sorted(actual) == sorted([*expected, *added])
    assert {k: v for k, v in actual.items() if k not in added} == expected


def test_every_runnable_generator_in_one_run_emits_the_same_files(tmp_path: Path) -> None:
    runnable = [
        e for i, e in enumerate(list_generators())
        if THREW not in _emit("without", [e], tmp_path / f"probe-{i}")
    ]
    expected = _emit("without", runnable, tmp_path / "a")
    actual = _emit("with", runnable, tmp_path / "b")
    assert THREW not in expected, expected.get(THREW)
    assert len(expected) > 10, f"only {len(expected)} files — the suite barely ran"
    added = sorted(f for files in SERVED_REPORT_FILES.values() for f in files)
    assert len(added) == 4
    assert sorted(set(actual) - set(expected)) == added
    assert set(expected) <= set(actual)
    assert {k: v for k, v in actual.items() if k in expected} == expected


def _api_docs(variant: str) -> dict[str, str]:
    """The api docs surface (``metaobjects docs``): every unit page, the index and the
    agent page. A served report is documented; every other report has no generated API."""
    model = PythonApiModelBuilder().build(_load(variant), "shop")
    pages = {
        doc_page_output_path(Layout.PACKAGE, unit.package, unit.node): render_unit_page(unit, None)
        for unit in model.units
    }
    pages["README.md"] = render_index(model, Layout.PACKAGE)
    pages["AGENT-API.md"] = render_agent_api(model)
    return dict(sorted(pages.items()))


_STORE_TOTALS_MARKERS = ("StoreTotals", "STORETOTALS", "store_totals")


def _without_store_totals(page: str) -> str:
    """A page with every line that names the served report removed, blank runs collapsed."""
    kept = [ln for ln in page.splitlines() if not any(m in ln for m in _STORE_TOTALS_MARKERS)]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).rstrip()


def test_api_docs_gain_only_the_served_report() -> None:
    expected = _api_docs("without")
    assert len(expected) > 3, f"only {len(expected)} pages — the docs barely ran"
    actual = _api_docs("with")
    # One new unit page, for the served report; the three sourceless reports get none.
    assert sorted(set(actual) - set(expected)) == ["acme/shop/StoreTotals.md"]
    assert set(expected) <= set(actual)
    page = actual["acme/shop/StoreTotals.md"]
    assert "GET /api/store_totals" in page
    # A report has no item route and no write verb, so none is documented.
    assert "POST" not in page and "{" not in page.split("GET /api/store_totals")[1].split("\n")[0]
    for name, text in expected.items():
        assert _without_store_totals(actual[name]) == _without_store_totals(text), name
    for name in expected:
        if name not in ("README.md", "AGENT-API.md"):
            assert actual[name] == expected[name], name


def test_exactly_these_generators_cannot_run_from_a_bare_model(tmp_path: Path) -> None:
    # Each is compared above on its error message alone, which proves nothing about its
    # output. Pinned by name so a generator that starts throwing cannot drop out silently;
    # the list may only shrink.
    threw = sorted(
        e.name for i, e in enumerate(list_generators())
        if THREW in _emit("without", [e], tmp_path / f"probe-{i}")
    )
    assert threw == []


def test_a_selection_of_only_unserved_reports_warns_that_there_is_nothing_to_generate(
    tmp_path: Path,
) -> None:
    result = run_gen(
        GenConfig(out_dir=str(tmp_path / "out")),
        _load("with"),
        generators=[_build(e, tmp_path) for e in list_generators()],
        entity_filter=["DailyRevenue", "ProgramEngagement", "ProgramCatalogue"],
    )
    assert result.files == []
    assert any(
        w.startswith("No entities to generate") and "object.report" in w for w in result.warnings
    ), result.warnings


def test_a_selection_of_only_reports_generates_only_the_served_one(tmp_path: Path) -> None:
    result = run_gen(
        GenConfig(out_dir=str(tmp_path / "out")),
        _load("with"),
        generators=[_build(e, tmp_path) for e in list_generators()],
        entity_filter=["DailyRevenue", "ProgramEngagement", "ProgramCatalogue", "StoreTotals"],
    )
    names = sorted(Path(path).name for path, _ in result.files)
    assert names == sorted(
        ["__init__.py", *(f for files in SERVED_REPORT_FILES.values() for f in files)]
    )
