"""ADR-0066 — the business-rules vocabulary is INERT in every Python generator.

1.3.0 registers ``api.operational``, ``operation.*``, ``binding.rest`` and ``transition.action``,
validates them at load and checks them in ``verify``. The generated services and enforcing
shells that act on them are later work, so until they land a model that USES the vocabulary
must generate exactly what the same model without it generates, byte for byte, through every
registered generator and every documentation generator.

The model pair is ``fixtures/codegen-noop/rules/{with,without}`` (see its README), shared with
the other ports' copies of this test. A generator that started reading an operation or a
transition by accident would emit something half-built; this test is what notices.

Runs through ``run_gen`` — the path ``metaobjects gen`` takes.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects import load_uris
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator import Generator
from metaobjects.codegen.generator_registry import (
    GeneratorBuildContext,
    GeneratorEntry,
    list_generators,
)
from metaobjects.codegen.runner import run_gen
from metaobjects.codegen.runtime.api_docs_builder import PythonApiModelBuilder
from metaobjects.codegen.runtime.api_docs_paths import Layout, doc_page_output_path
from metaobjects.codegen.runtime.api_docs_renderer import render_agent_api, render_index, render_unit_page
from metaobjects.meta.core.transition.lifecycle import entity_transitions
from metaobjects.shared.base_types import TYPE_API, TYPE_OBJECT

MODELS = Path(__file__).parents[3] / "fixtures" / "codegen-noop" / "rules"
THREW = "<threw>"


def _load(variant: str):
    result = load_uris([(MODELS / variant / "meta.purchasing.json").as_uri()])
    assert not result.errors, "\n".join(e.message for e in result.errors)
    return result.root


def _build(entry: GeneratorEntry, template_root: Path) -> Generator:
    return entry.factory(GeneratorBuildContext(template_root=str(template_root)))


def _emit(variant: str, entries: list[GeneratorEntry], tmp: Path) -> dict[str, str]:
    """Run a generator suite into a fresh directory and read back every file it wrote.

    A throw is recorded as the single entry ``<threw>``, so a generator that cannot run from
    a bare model must at least fail identically.
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
    with_root = _load("with")
    # ADR-0039: resolving — the root is never extended, so children() == own_children().
    apis = [c for c in with_root.children() if c.type == TYPE_API]
    assert [a.name for a in apis] == ["Purchasing"]
    assert len(apis[0].children()) == 3
    request = next(c for c in with_root.children() if c.type == TYPE_OBJECT and c.name == "PurchaseRequest")
    assert len(entity_transitions(request)) == 3
    without_root = _load("without")
    assert not any(c.type == TYPE_API for c in without_root.children())
    request = next(c for c in without_root.children() if c.type == TYPE_OBJECT and c.name == "PurchaseRequest")
    assert entity_transitions(request) == []


#: The explorer documents every node, so a declared API and each transition are more nodes in it:
#: held to its own test below (only the model-derived files move), not to byte equality.
DOCS_SITE = "docs-site"
MODEL_FILES = {"site/explorer.json", "site/explorer-model.js", "site/explorer-stamp.js"}


def _inert_generators() -> list[GeneratorEntry]:
    return [e for e in list_generators() if e.name != DOCS_SITE]


def test_docs_site_differs_only_in_the_model_derived_files(tmp_path: Path) -> None:
    entry = next(e for e in list_generators() if e.name == DOCS_SITE)
    without = _emit("without", [entry], tmp_path / "a")
    with_ = _emit("with", [entry], tmp_path / "b")
    assert THREW not in without, without.get(THREW)
    assert set(without) == set(with_)
    assert {k for k in without if without[k] != with_[k]} == MODEL_FILES
    nodes = lambda files: len(json.loads(files["site/explorer.json"])["nodes"])  # noqa: E731
    assert nodes(with_) > nodes(without)


@pytest.mark.parametrize("entry", _inert_generators(), ids=lambda e: e.name)
def test_generator_emits_the_same_files_with_and_without_rules_nodes(
    entry: GeneratorEntry, tmp_path: Path
) -> None:
    # `list_generators()` includes the documentation generator (`api-docs`): its pages are
    # held to the same byte-for-byte rule here.
    expected = _emit("without", [entry], tmp_path / "a")
    actual = _emit("with", [entry], tmp_path / "b")
    assert actual == expected


def test_every_runnable_generator_in_one_run_emits_the_same_files(tmp_path: Path) -> None:
    runnable = [
        e for i, e in enumerate(_inert_generators())
        if THREW not in _emit("without", [e], tmp_path / f"probe-{i}")
    ]
    expected = _emit("without", runnable, tmp_path / "a")
    actual = _emit("with", runnable, tmp_path / "b")
    assert THREW not in expected, expected.get(THREW)
    assert len(expected) > 10, f"only {len(expected)} files — the suite barely ran"
    assert actual == expected


def _api_docs(variant: str) -> dict[str, str]:
    """The api docs surface: every unit page, the index and the agent page."""
    model = PythonApiModelBuilder().build(_load(variant), "purchasing")
    pages = {
        doc_page_output_path(Layout.PACKAGE, unit.package, unit.node): render_unit_page(unit, None)
        for unit in model.units
    }
    pages["README.md"] = render_index(model, Layout.PACKAGE)
    pages["AGENT-API.md"] = render_agent_api(model)
    return dict(sorted(pages.items()))


def test_api_docs_are_byte_identical_with_and_without_rules_nodes() -> None:
    expected = _api_docs("without")
    assert len(expected) > 3, f"only {len(expected)} pages — the docs barely ran"
    assert _api_docs("with") == expected


def test_exactly_these_generators_cannot_run_from_a_bare_model(tmp_path: Path) -> None:
    # Pinned so a generator that starts throwing cannot drop out of the comparison silently;
    # the list may only shrink.
    threw = sorted(
        e.name for i, e in enumerate(_inert_generators())
        if THREW in _emit("without", [e], tmp_path / f"probe-{i}")
    )
    assert threw == []
