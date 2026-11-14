"""``metaobjects verify`` — the ``unbounded-list-pages`` advisory.

A project that generates REST list routes and sets no ``api.pagination`` is told so on stderr.
It is advisory: it never reaches the exit code, and a project that sets the block is not told.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.cli import main
from tests.codegen.config_helpers import as_config
from tests.codegen.gen_suite import GEN_SUITE

_ADVISORY = "unbounded-list-pages"


def _project(tmp_path: Path, api: dict[str, object] | None) -> str:
    project = tmp_path / "proj"
    (project / ".metaobjects").mkdir(parents=True)
    cfg: dict[str, object] = {"schema_version": 1}
    if api is not None:
        cfg["api"] = api
    (project / ".metaobjects" / "config.json").write_text(json.dumps(cfg))
    doc = {
        "metadata.root": {
            "package": "app",
            "children": [
                {
                    "object.entity": {
                        "name": "Item",
                        "children": [
                            {"source.rdb": {"@table": "items"}},
                            {"field.long": {"name": "id"}},
                            {"identity.primary": {"name": "pk", "@fields": ["id"]}},
                        ],
                    }
                }
            ],
        }
    }
    meta = project / "metaobjects"
    meta.mkdir()
    (meta / "meta.app.json").write_text(json.dumps(doc))
    return str(meta)


def _verify(tmp_path: Path, meta_dir: str, generators: str = GEN_SUITE) -> int:
    out = tmp_path / "out"
    assert main(as_config(["gen", "--generators", generators, meta_dir, "--out", str(out)])) == 0
    return main(as_config(["verify", "--codegen", "--generators", generators, meta_dir, "--out", str(out)]))


def test_advises_when_routes_are_generated_and_no_page_size_is_set(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert _verify(tmp_path, _project(tmp_path, None)) == 0
    assert _ADVISORY in capsys.readouterr().err


def test_silent_when_the_project_sets_api_pagination(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    api = {"pagination": {"defaultLimit": 50, "maxLimit": 1000}}
    assert _verify(tmp_path, _project(tmp_path, api)) == 0
    assert _ADVISORY not in capsys.readouterr().err


def test_silent_when_no_routes_generator_is_wired(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # Entities and models only, no routers: nothing generated serves a list, so there is no
    # page size to advise on (an owned routes copy is the adopter's, as in the other ports).
    assert _verify(tmp_path, _project(tmp_path, None), "entity,filter-allowlist,names") == 0
    assert _ADVISORY not in capsys.readouterr().err
