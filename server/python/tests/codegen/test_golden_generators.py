"""Byte-exact expected files for the router, names and filter-allowlist generators.

The entity-model generator has had byte-exact goldens (``test_golden.py``) from the
start. These three did not: their tests assert on fragments of the emitted text, so a
change that reflows the output, reorders a section or moves a blank line passes every
one of them. The writer conversion (W-PY-1 onward) rewrites how this text is laid out;
it needs a net that fails on a single changed byte, laid before anything is converted.

The input is the shared cross-port fitness corpus
(``fixtures/persistence-conformance/canonical/meta.fitness.json``): it already carries
tables, views, projections, reports, enums, value objects, a many-to-many, a TPH
hierarchy and a derived key, which is what the router's branches turn on.

To refresh after a change that is MEANT to alter the output::

    METAOBJECTS_UPDATE_GOLDEN=1 uv run pytest tests/codegen/test_golden_generators.py

and review the diff of ``tests/codegen/golden_generators/expected`` in the PR.
"""
from __future__ import annotations

import os
from pathlib import Path

from metaobjects import load_uris
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generators.filter_allowlist_generator import (
    filter_allowlist_generator,
)
from metaobjects.codegen.generators.names_generator import names_generator
from metaobjects.codegen.generators.router_generator import router_generator
from metaobjects.codegen.runner import run_gen

CORPUS = (
    Path(__file__).parents[4]
    / "fixtures"
    / "persistence-conformance"
    / "canonical"
    / "meta.fitness.json"
)
EXPECTED = Path(__file__).parent / "golden_generators" / "expected"

#: Only the three generators this net covers. Emitting just their files keeps the
#: expected tree small and means an entity-model change cannot move these bytes.
_SUFFIXES = ("_router.py", "_names.py", "_filter_allowlist.py")


def _generate(out: Path) -> dict[str, str]:
    result = load_uris([CORPUS.as_uri()])
    assert not result.errors, [e.message for e in result.errors]
    run_gen(
        GenConfig(out_dir=str(out)),
        result.root,
        generators=[router_generator(), names_generator(), filter_allowlist_generator()],
    )
    return {
        p.relative_to(out).as_posix(): p.read_text(encoding="utf-8")
        for p in sorted(out.rglob("*.py"))
    }


def test_router_names_and_filter_allowlist_match_the_expected_bytes(tmp_path: Path) -> None:
    actual = _generate(tmp_path / "gen")
    assert actual, "the corpus generated nothing"
    # Every one of the three generators must have emitted something, or the net is empty.
    for suffix in _SUFFIXES:
        assert any(n.endswith(suffix) for n in actual), f"no {suffix} file was emitted"

    if os.environ.get("METAOBJECTS_UPDATE_GOLDEN") == "1":
        EXPECTED.mkdir(parents=True, exist_ok=True)
        for stale in EXPECTED.glob("*.py"):
            stale.unlink()
        for name, text in actual.items():
            (EXPECTED / name).write_text(text, encoding="utf-8")

    expected = {
        p.relative_to(EXPECTED).as_posix(): p.read_text(encoding="utf-8")
        for p in sorted(EXPECTED.rglob("*.py"))
    }
    assert sorted(actual) == sorted(expected), "the set of emitted files changed"
    for name in sorted(actual):
        assert actual[name] == expected[name], f"{name} no longer matches its expected bytes"
