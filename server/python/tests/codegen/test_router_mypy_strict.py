"""Generated FastAPI routers type-check under ``mypy --strict``.

``metaobjects gen`` over the shared fitness corpus used to emit routers with 129 strict
errors: the repository ``Protocol`` declares a method named ``list``, so every later
``list[...]`` annotation in the class body resolved to that method (``valid-type``), and the
delete / M:N handlers returned a ``JSONResponse`` or ``Any`` from a function declared
``-> None`` / ``-> list[Any]`` (``return-value`` / ``no-any-return``). An adopter running
``mypy --strict`` was the first thing to notice, which is what the codegen-compile gate
(``test_codegen_compile_conformance.py``) exists to prevent for the tiers it covers; it
excludes the framework-bound router tier, so this closes that for Python.

Only errors in the emitted ``*_router.py`` modules are asserted. The model tier has its own
strict findings that are not this gate's concern.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

pytest.importorskip("mypy")
pytest.importorskip("fastapi")

from metaobjects import load_uris  # noqa: E402
from metaobjects.codegen.config import GenConfig  # noqa: E402
from metaobjects.codegen.generators.entity_model import entity_model  # noqa: E402
from metaobjects.codegen.generators.filter_allowlist_generator import (  # noqa: E402
    filter_allowlist_generator,
)
from metaobjects.codegen.generators.router_generator import router_generator  # noqa: E402
from metaobjects.codegen.runner import run_gen  # noqa: E402

# tests/codegen/ -> tests -> python -> server -> repo root
CORPUS = (
    Path(__file__).parents[4]
    / "fixtures"
    / "persistence-conformance"
    / "canonical"
    / "meta.fitness.json"
)


def test_generated_routers_pass_mypy_strict(tmp_path: Path) -> None:
    loaded = load_uris([CORPUS.as_uri()])
    assert not loaded.errors
    out_dir = tmp_path / "generated"
    run_gen(
        GenConfig(out_dir=str(out_dir), emit_package_init=True),
        loaded.root,
        generators=[entity_model(), filter_allowlist_generator(), router_generator()],
    )
    routers = sorted(out_dir.glob("*_router.py"))
    assert routers, "the corpus generated no routers at all"

    config = tmp_path / "mypy.ini"  # empty: never inherit the repo's or the user's settings
    config.write_text("[mypy]\n")
    proc = subprocess.run(
        [
            sys.executable, "-m", "mypy",
            "--strict",
            "--config-file", str(config),
            "--cache-dir", str(tmp_path / ".mypy_cache"),
            "--no-error-summary",
            str(out_dir),
        ],
        capture_output=True,
        text=True,
        cwd=tmp_path,
    )
    assert proc.returncode in (0, 1), f"mypy did not run: {proc.stdout}{proc.stderr}"  # 2 = crash
    router_errors = [
        line
        for line in proc.stdout.splitlines()
        if "_router.py" in line.split(":", 1)[0] and ": error:" in line
    ]
    assert not router_errors, (
        f"{len(router_errors)} `mypy --strict` error(s) in the generated routers:\n"
        + "\n".join(router_errors)
    )
