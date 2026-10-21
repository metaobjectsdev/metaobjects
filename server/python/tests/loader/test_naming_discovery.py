"""B1: the loaders find the project's `naming` the way codegen and verify do."""
from __future__ import annotations

import json
import warnings
from pathlib import Path

import pytest

from metaobjects import load_directory, load_string, load_uris
from metaobjects.naming import NamingRules, attach_naming

_META = {
    "metadata.root": {
        "package": "acme::shop",
        "children": [
            {"object.entity": {"name": "Item", "children": [
                {"source.rdb": {"@table": "items"}},
                {"field.long": {"name": "id"}},
                {"field.string": {"name": "unitPrice"}},
                {"identity.primary": {"name": "pk", "@fields": ["id"]}},
            ]}}
        ],
    }
}


def _project(tmp_path: Path, naming: dict | None, nested: str = "metaobjects") -> Path:
    if naming is not None:
        (tmp_path / ".metaobjects").mkdir()
        (tmp_path / ".metaobjects" / "config.json").write_text(
            json.dumps({"schema_version": 1, "naming": naming})
        )
    meta = tmp_path / nested
    meta.mkdir(parents=True)
    (meta / "meta.shop.json").write_text(json.dumps(_META))
    return meta


def test_load_directory_reads_the_project_naming(tmp_path: Path) -> None:
    meta = _project(tmp_path, {"columns": "literal"})
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        root = load_directory(meta).root
    assert root.naming == NamingRules(columns="literal")  # type: ignore[attr-defined]


def test_the_search_walks_up_from_a_nested_metadata_directory(tmp_path: Path) -> None:
    meta = _project(tmp_path, {"columns": "literal"}, nested="src/models/metaobjects")
    assert load_directory(meta).root.naming.columns == "literal"  # type: ignore[attr-defined]


def test_load_uris_reads_the_project_naming_from_the_first_file_uri(tmp_path: Path) -> None:
    meta = _project(tmp_path, {"columns": "literal"})
    root = load_uris([(meta / "meta.shop.json").as_uri()]).root
    assert root.naming.columns == "literal"  # type: ignore[attr-defined]


def test_load_string_takes_a_project_dir(tmp_path: Path) -> None:
    _project(tmp_path, {"columns": "literal"})
    root = load_string(json.dumps(_META), project_dir=tmp_path).root
    assert root.naming.columns == "literal"  # type: ignore[attr-defined]


def test_load_string_without_a_project_keeps_the_default_quietly() -> None:
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        root = load_string(json.dumps(_META)).root
    assert root.naming == NamingRules()  # type: ignore[attr-defined]


def test_no_config_warns_once_naming_the_setting_and_attach_naming(tmp_path: Path) -> None:
    meta = _project(tmp_path, None)
    with pytest.warns(UserWarning) as rec:
        root = load_directory(meta).root
    messages = [str(w.message) for w in rec if "snake_case" in str(w.message)]
    assert len(messages) == 1
    assert '"naming"' in messages[0] and "attach_naming" in messages[0]
    assert root.naming == NamingRules()  # type: ignore[attr-defined]


def test_load_uris_without_config_warns(tmp_path: Path) -> None:
    meta = _project(tmp_path, None)
    with pytest.warns(UserWarning, match="attach_naming"):
        load_uris([(meta / "meta.shop.json").as_uri()])


def test_an_explicit_attach_naming_wins(tmp_path: Path) -> None:
    meta = _project(tmp_path, {"columns": "literal"})
    other = tmp_path / "other"
    (other / ".metaobjects").mkdir(parents=True)
    (other / ".metaobjects" / "config.json").write_text(
        json.dumps({"schema_version": 1, "naming": {"columns": "snake_case", "tables": "literal"}})
    )
    root = attach_naming(load_directory(meta).root, other)
    assert root.naming == NamingRules(columns="snake_case", tables="literal")  # type: ignore[attr-defined]


def test_discovery_can_be_turned_off(tmp_path: Path) -> None:
    meta = _project(tmp_path, {"columns": "literal"})
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        root = load_directory(meta, discover_naming=False).root
    assert root.naming == NamingRules()  # type: ignore[attr-defined]
