"""Path-math unit test for the Python api-docs surface (Phase 2, Task 2.1).

Asserts ``doc_page_output_path`` + ``model_cross_href`` reproduce the shared
cross-port manifest's ``apiPythonPath`` / ``apiPythonToModel`` for EVERY unit,
in the ``package`` layout. This pins the Python path math to the SAME contract
the TS oracle regenerates, so the surface resolves identically on disk across
all five ports — independent of the builder/renderer.
"""
from __future__ import annotations

import json
from pathlib import Path

from metaobjects.apidocs.paths import (
    Layout,
    doc_page_output_path,
    model_cross_href,
)

_API_PYTHON_SUBDIR = "api/python"


def _repo_root() -> Path:
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        if (parent / "fixtures").is_dir() and (parent / "server").is_dir():
            return parent
    raise RuntimeError("could not locate the repo root")


def _manifest() -> dict:
    case = _repo_root() / "fixtures" / "conformance" / "api-docs-cross-port"
    with (case / "expected-paths.json").open(encoding="utf-8") as fh:
        return json.load(fh)


def test_doc_page_output_path_matches_manifest_for_every_unit() -> None:
    manifest = _manifest()
    assert manifest["layout"] == "package"
    assert manifest["apiPythonSubDir"] == _API_PYTHON_SUBDIR

    for unit in manifest["units"]:
        # The manifest stores the page path INCLUDING the api/python subdir.
        page_path = doc_page_output_path(Layout.PACKAGE, "acme::shop", unit["node"])
        expected = unit["apiPythonPath"]
        assert f"{_API_PYTHON_SUBDIR}/{page_path}" == expected, (
            f"unit {unit['node']}: {_API_PYTHON_SUBDIR}/{page_path} != {expected}"
        )


def test_model_cross_href_matches_manifest_for_every_unit() -> None:
    manifest = _manifest()
    for unit in manifest["units"]:
        api_page_path = unit["apiPythonPath"]  # e.g. api/python/acme/shop/Order.md
        model_page_path = unit["modelPath"]  # e.g. acme/shop/Order.md
        href = model_cross_href(api_page_path, model_page_path)
        assert href == unit["apiPythonToModel"], (
            f"unit {unit['node']}: {href} != {unit['apiPythonToModel']}"
        )
