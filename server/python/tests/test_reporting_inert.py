"""FR-044 Plan 1 — the reporting vocabulary is INERT in every Python generator.

Plan 1 registers ``dimension.*``, ``measure.*``, ``segment.*`` and ``object.report`` and
validates them at load, but gives none of them output: a report's lowering lands in Plan
2/3. Until then a model that USES the vocabulary must generate exactly what the same model
without it generates, byte for byte, through every registered generator.

The model pair is ``fixtures/codegen-noop/reporting/{with,without}``, shared with the other
four ports' copies of this test. ``with/`` carries a report that declares a read-only
``source.rdb @kind: view`` (R5 allows one) — the shape that leaked in C#. Here the
``entity`` generator used to write an empty ``BaseModel`` module per report.

Runs through ``run_gen`` — the path ``metaobjects gen`` takes — because the skip lives at
its entity-set choke point.
"""
from __future__ import annotations

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
from metaobjects.meta.core.object.object_constants import OBJECT_SUBTYPE_REPORT
from metaobjects.shared.base_types import TYPE_OBJECT

MODELS = Path(__file__).parents[3] / "fixtures" / "codegen-noop" / "reporting"
THREW = "<threw>"


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
    assert reports == ["DailyRevenue", "ProgramEngagement", "StoreTotals"]
    assert not any(o.sub_type == OBJECT_SUBTYPE_REPORT for o in _objects("without"))


@pytest.mark.parametrize("entry", list_generators(), ids=lambda e: e.name)
def test_generator_emits_the_same_files_with_and_without_reporting_nodes(
    entry: GeneratorEntry, tmp_path: Path
) -> None:
    expected = _emit("without", [entry], tmp_path / "a")
    actual = _emit("with", [entry], tmp_path / "b")
    assert list(actual) == list(expected)
    assert actual == expected


def test_every_runnable_generator_in_one_run_emits_the_same_files(tmp_path: Path) -> None:
    runnable = [
        e for i, e in enumerate(list_generators())
        if THREW not in _emit("without", [e], tmp_path / f"probe-{i}")
    ]
    expected = _emit("without", runnable, tmp_path / "a")
    actual = _emit("with", runnable, tmp_path / "b")
    assert THREW not in expected, expected.get(THREW)
    assert len(expected) > 10, f"only {len(expected)} files — the suite barely ran"
    assert list(actual) == list(expected)
    assert actual == expected
