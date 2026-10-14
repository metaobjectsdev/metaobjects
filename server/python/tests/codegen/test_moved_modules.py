"""The emitters that moved into ``metaobjects.codegen.runtime`` keep answering at their old paths.

``metaobjects eject`` copies the emitters a generator writes through from
``metaobjects/codegen/runtime/``, so they moved there. A generator ejected before they moved
imports them from the old paths; each old path is a deprecated alias that IS the new module
(same object, so private names and monkeypatching behave as before) and warns once, with a
``FutureWarning`` (shown by default) that names the release that removes it.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

import metaobjects

MOVED = {
    "metaobjects.codegen.extract_delegate_emitter": "metaobjects.codegen.runtime.extract_delegate_emitter",
    "metaobjects.codegen.fr010_field_mapping": "metaobjects.codegen.runtime.fr010_field_mapping",
    "metaobjects.codegen.output_format_spec_emitter": "metaobjects.codegen.runtime.output_format_spec_emitter",
    "metaobjects.codegen.extract_schema_emitter": "metaobjects.codegen.runtime.extract_schema_emitter",
    "metaobjects.codegen.generators.fr019_shared_enum": "metaobjects.codegen.runtime.fr019_shared_enum",
    "metaobjects.codegen.generators.m2m_codegen": "metaobjects.codegen.runtime.m2m_codegen",
    "metaobjects.apidocs.api_model": "metaobjects.codegen.runtime.api_docs_model",
    "metaobjects.apidocs.builder": "metaobjects.codegen.runtime.api_docs_builder",
    "metaobjects.apidocs.renderer": "metaobjects.codegen.runtime.api_docs_renderer",
    "metaobjects.apidocs.paths": "metaobjects.codegen.runtime.api_docs_paths",
}


@pytest.mark.parametrize("old, new", sorted(MOVED.items()))
def test_an_old_path_is_the_new_module_and_warns(old: str, new: str, tmp_path: Path) -> None:
    # A fresh interpreter: in this process the old path may already be imported, which warns once.
    src = str(Path(metaobjects.__file__).resolve().parents[1])
    code = (
        "import importlib, json, warnings\n"
        "with warnings.catch_warnings(record=True) as w:\n"
        "    warnings.simplefilter('always')\n"
        f"    old = importlib.import_module({old!r})\n"
        f"new = importlib.import_module({new!r})\n"
        "print(json.dumps({'same': old is new, "
        "'warned': [str(x.message) for x in w if issubclass(x.category, FutureWarning)]}))\n"
    )
    proc = subprocess.run(
        [sys.executable, "-c", code], cwd=tmp_path, capture_output=True, text=True,
        env={**os.environ, "PYTHONPATH": os.pathsep.join(
            p for p in (src, os.environ.get("PYTHONPATH", "")) if p)},
    )
    assert proc.returncode == 0, proc.stderr
    result = json.loads(proc.stdout)
    assert result["same"] is True
    assert len(result["warned"]) == 1 and old in result["warned"][0] and new in result["warned"][0]
    assert "removed in 2.0" in result["warned"][0]
