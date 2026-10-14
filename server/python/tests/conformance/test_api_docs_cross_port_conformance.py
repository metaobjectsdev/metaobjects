"""Cross-port api-docs LAYOUT conformance gate — the PYTHON half (Phase 0: RED).

This is the Python counterpart of the Java ``ApiDocsCrossPortConformanceTest`` and
the TS api-docs conformance test. All three assert against the SAME shared contract,
``fixtures/conformance/api-docs-cross-port/expected-paths.json``, so the polyglot doc
tree coheres: a ``model`` page links to ``api/ts`` AND ``api/java`` AND ``api/python``,
and each api page links back to the same model page with hrefs that resolve identically
on disk.

Since 1.1.0 the Python api reference is the ``api-docs`` generator, declared in a target of
``metaobjects.config.yaml`` and run by ``metaobjects gen`` (ADR-0034 Amendment 9; it was the
``metaobjects docs`` command). This test declares it over the shared input and asserts the
``api/python`` pages are produced with the contract back-link.
"""

from __future__ import annotations

import json
from pathlib import Path

from metaobjects import cli


def _repo_root() -> Path:
    """Walk up to the dir holding both ``fixtures/`` and ``server/``."""
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        if (parent / "fixtures").is_dir() and (parent / "server").is_dir():
            return parent
    raise RuntimeError(
        "could not locate the repo root (a dir containing both fixtures/ and server/) "
        f"walking up from {here}"
    )


_ROOT = _repo_root()
_CASE_DIR = _ROOT / "fixtures" / "conformance" / "api-docs-cross-port"


def _drive_python_docs(input_dir: Path, out_dir: Path) -> None:
    """Run the Python api reference end-to-end: ``api-docs`` declared in a config target whose
    ``outDir`` is *out_dir*, run by ``metaobjects gen``."""
    config = out_dir.parent / "metaobjects.config.yaml"
    config.write_text(
        f"metadata: {json.dumps(str(input_dir))}\n"
        f"targets:\n  docs:\n    outDir: {json.dumps(str(out_dir))}\n    generators: [api-docs]\n",
        encoding="utf-8",
    )
    assert cli.main(["gen", "--config", str(config)]) == 0


def test_python_api_docs_paths_and_back_links_match_shared_manifest(tmp_path: Path) -> None:
    # ---- load the shared contract (plain dict — unknown fields are fine) ----
    with (_CASE_DIR / "expected-paths.json").open(encoding="utf-8") as fh:
        manifest = json.load(fh)

    assert manifest["layout"] == "package", "manifest layout must be 'package'"
    assert (
        manifest["apiPythonSubDir"] == "api/python"
    ), "manifest apiPythonSubDir must be 'api/python'"

    # ---- drive the Python docs entrypoint over the SAME input the other ports load ----
    input_dir = _CASE_DIR / "input"
    out_dir = tmp_path / "docs-out"
    _drive_python_docs(input_dir, out_dir)

    # ---- per-unit: the api/python page exists AND carries the contract back-link ----
    units = manifest["units"]
    assert units, "manifest must declare at least one unit"

    for unit in units:
        node = unit["node"]
        api_python_path = unit["apiPythonPath"]
        api_python_to_model = unit["apiPythonToModel"]

        page = out_dir / api_python_path
        assert page.is_file(), (
            f"Python api-docs surface did not produce '{api_python_path}' for unit "
            f"'{node}'. Searched under: {out_dir}"
        )

        contents = page.read_text(encoding="utf-8")
        expected_back_link = f"**Model / metadata:** [{node}]({api_python_to_model})"
        assert expected_back_link in contents, (
            f"rendered api/python page for '{node}' must carry the contract back-link:\n"
            f"  {expected_back_link}\nactual page:\n{contents}"
        )
