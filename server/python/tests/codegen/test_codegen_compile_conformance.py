"""CODEGEN-COMPILE CONFORMANCE (Python lane).

Generate from the SHARED cross-port corpus — ``fixtures/persistence-conformance/
canonical/meta.fitness.json`` — and prove every emitted module actually loads.

WHY THIS EXISTS. Four defects shipped in 1.0.4 that every existing gate was blind to,
because each one produced output that PARSES and GENERATES cleanly and only fails when
somebody builds it:

  - a view over an int-backed enum imported a codec drizzle does not export (TS);
  - a renamed projection field selected a column that does not exist (TS);
  - a DbContext named FK config through ``nameof`` on a member that is not there (C#);
  - an extract mapper did not compile for most scalar subtypes (Java).

``metaobjects gen`` exits 0 in all four cases. The metamodel, render, persistence,
api-contract and registry corpora all stay green — they gate BEHAVIOR, and none of them
asks whether the emitted code builds. The adopter's build is the first thing that does,
which makes the adopter the gate. This closes that.

WHY TWO CHECKS, NOT ONE. Python has no static compiler, so the peer ports' single
"zero diagnostics" assertion has to be reconstructed from two halves, and neither half
alone is the gate:

  1. IMPORT the generated package. ``compile()`` alone only parses — it cannot tell a
     name that does not exist from one that does. Importing runs each module's top level
     for real, which is what resolves the package-relative imports the generators emit
     BETWEEN modules; that cross-module agreement is the defect class the TS lane's
     ``ts.createProgram`` catches and a per-file check structurally cannot.
  2. ``ruff check`` for undefined names. Importing only executes the module's top level,
     so an undefined name inside a function body that nothing calls stays invisible.
     F821 reads those branches statically. ruff is in the ``[dependency-groups] dev``
     group ``uv run`` installs, so it is present wherever this test runs; mypy is NOT
     (it is declared only under ``[project.optional-dependencies] dev``), which is why
     this does not reach for it.

WHAT IT EXCLUDES: the ``routes`` generator, whose output imports FastAPI. Every peer
port draws the same line for the same reason (TS omits routesFile, C# omits
RoutesGenerator, Java omits SpringControllerGenerator) — the framework tier is proven by
the api-contract integration lane, which boots the generated router over real HTTP. It
also keeps this file runnable without ``--extra integration``.

The prompt-tier generators (output-parser / output-prompt / render-helper / extractor /
trace-helper) are absent because they key off ``template.*`` nodes and this corpus
declares none — including them would emit nothing and read as coverage that is not
there. That tier imports the entity tier's value-object models (ADR-0056); the pair is
generated, imported and run together by ``test_extract_tier_collision.py`` and
``test_render_helper_conformance.py``.

The peer lanes are the same test in each port. If one port drops out, that port keeps
precisely the bug class this exists to catch — so a skip here is never "just this lane".
"""
from __future__ import annotations

import importlib
import subprocess
import sys
from pathlib import Path

from metaobjects import load_uris
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generators.entity_model import entity_model
from metaobjects.codegen.generators.filter_allowlist_generator import (
    filter_allowlist_generator,
)
from metaobjects.codegen.generators.names_generator import names_generator
from metaobjects.codegen.runner import run_gen

# tests/codegen/ -> tests -> python -> server -> repo root
CORPUS = (
    Path(__file__).parents[4]
    / "fixtures"
    / "persistence-conformance"
    / "canonical"
    / "meta.fitness.json"
)


def _load_corpus():
    result = load_uris([CORPUS.as_uri()])
    assert not result.errors, "The shared corpus must load cleanly before anything " \
        "can be generated from it:\n" + "\n".join(
            f"  {getattr(e, 'code', 'ERROR')}: {e.message}" for e in result.errors
        )
    return result.root


def _generate(out_dir: Path) -> list[Path]:
    """Run the model-tier generators through run_gen — the real orchestrator.

    Going through ``run_gen`` rather than calling ``generate()`` on each generator is
    deliberate: it is what composes each generator's own ``filter`` into ``ctx.matches``
    (``runner._matcher``) and what emits the ``__init__.py`` files that make the output
    an importable package. A harness that skipped it would measure itself.
    """
    config = GenConfig(out_dir=str(out_dir), emit_package_init=True)
    result = run_gen(
        config,
        _load_corpus(),
        generators=[entity_model(), names_generator(), filter_allowlist_generator()],
    )
    written = sorted(out_dir.rglob("*.py"))
    assert written, f"the corpus generated no Python modules at all: {result.warnings}"
    return written


def test_every_generated_module_imports(tmp_path: Path) -> None:
    """Import each emitted module for real — the cross-module resolution check."""
    out_dir = tmp_path / "generated"
    written = _generate(out_dir)

    sys.path.insert(0, str(tmp_path))
    try:
        failures: list[str] = []
        for path in written:
            dotted = ".".join(path.relative_to(tmp_path).with_suffix("").parts)
            # A package's __init__ is imported under the package's own name.
            if dotted.endswith(".__init__"):
                dotted = dotted[: -len(".__init__")]
            try:
                importlib.import_module(dotted)
            except Exception as exc:  # noqa: BLE001 — every failure mode is a finding
                failures.append(f"{path.relative_to(out_dir)}: {type(exc).__name__}: {exc}")
        assert not failures, (
            f"`metaobjects gen` over the shared fitness corpus emitted {len(written)} "
            f"module(s), {len(failures)} of which do not import:\n" + "\n".join(failures)
        )
    finally:
        sys.path.remove(str(tmp_path))
        for name in [m for m in sys.modules if m.split(".")[0] == "generated"]:
            del sys.modules[name]


def test_no_generated_module_references_an_undefined_name(tmp_path: Path) -> None:
    """ruff F821 over the emitted tree — the branches importing never executes.

    Scoped to the name-resolution rules on purpose. A generated file is allowed to be
    untidy (an unused import is not an adopter's broken build); it is not allowed to
    name something that does not exist.
    """
    out_dir = tmp_path / "generated"
    _generate(out_dir)

    proc = subprocess.run(
        [
            sys.executable, "-m", "ruff", "check",
            "--no-cache",
            "--isolated",  # never inherit the repo's own ruff config
            "--select", "F821,F822,F811,E9",
            "--output-format", "concise",
            str(out_dir),
        ],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, (
        "`metaobjects gen` over the shared fitness corpus emitted code that names "
        "something undefined:\n" + proc.stdout + proc.stderr
    )
