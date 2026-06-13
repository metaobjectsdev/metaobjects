"""Cross-port api-docs LAYOUT conformance gate — the PYTHON half (Phase 0: RED).

This is the Python counterpart of the Java ``ApiDocsCrossPortConformanceTest`` and
the TS api-docs conformance test. All three assert against the SAME shared contract,
``fixtures/conformance/api-docs-cross-port/expected-paths.json``, so the polyglot doc
tree coheres: a ``model`` page links to ``api/ts`` AND ``api/java`` AND ``api/python``,
and each api page links back to the same model page with hrefs that resolve identically
on disk.

Python has NO native SDK-docs (``api/python``) surface yet — the ``metaobjects`` CLI
exposes ``gen`` / ``verify`` / ``agent-docs`` but no ``docs`` subcommand. This test
drives that not-yet-existing entrypoint end-to-end and asserts the ``api/python`` pages
are produced with the contract back-link. Because the feature does not exist, no files
are written and the assertions FAIL.

This RED is intentional (Phase 0 of the cross-port SDK-docs plan): it pins the contract
the Python ``docs`` surface must satisfy BEFORE any implementation lands. Do NOT weaken
or skip it to make CI green — make it pass by implementing the Python ``docs`` surface.
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
    """Run the Python ``docs`` entrypoint end-to-end.

    ``docs`` is not (yet) a registered ``metaobjects`` subcommand, so argparse rejects
    it and ``cli.main`` raises ``SystemExit(2)`` writing nothing. We swallow that here so
    the test proceeds to its file-existence assertions — which are the intended RED. Once
    the Python ``docs`` surface exists this call writes the ``api/python`` tree and the
    assertions pass.
    """
    try:
        cli.main(["docs", str(input_dir), "--out", str(out_dir)])
    except SystemExit:
        # No "docs" subcommand yet → argparse exits 2 without producing output.
        # The real assertion is on the (absent) api/python files below.
        pass


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
            f"'{node}'. The 'docs' subcommand / api/python surface does not exist yet "
            f"(Phase 0 RED). Searched under: {out_dir}"
        )

        contents = page.read_text(encoding="utf-8")
        expected_back_link = f"**Model / metadata:** [{node}]({api_python_to_model})"
        assert expected_back_link in contents, (
            f"rendered api/python page for '{node}' must carry the contract back-link:\n"
            f"  {expected_back_link}\nactual page:\n{contents}"
        )
