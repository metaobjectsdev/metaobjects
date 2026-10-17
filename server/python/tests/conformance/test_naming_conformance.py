"""ADR-0058 cross-port conformance: ``fixtures/naming-conformance/physical-names/``.

Every port parses each case's ``naming`` block with its OWN config reader
(``metaobjects.config.neutral_config``), loads ``meta.naming.json``, sets the root's
naming rules, and resolves every table and column name through the SAME resolvers
codegen and the runtime use — ``MetaSource.physical_name()`` and
``metaobjects.naming.resolve_column_name()``. Every ``invalid`` block must be refused
when the config is read.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects import FileSource, MetaDataLoader
from metaobjects.config.neutral_config import read_neutral_config
from metaobjects.errors import ParseError
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.naming import resolve_column_name
from metaobjects.shared.base_types import TYPE_OBJECT
from metaobjects.source_resolution import primary_rdb_source

REPO = Path(__file__).parents[4]
CORPUS = REPO / "fixtures" / "naming-conformance" / "physical-names"
CASES_FILE = CORPUS / "cases.json"
META_FILE = CORPUS / "meta.naming.json"

_SPEC = json.loads(CASES_FILE.read_text())
_CASES: list[dict[str, object]] = _SPEC["cases"]
_INVALID: list[dict[str, object]] = _SPEC["invalid"]


def _load_root() -> MetaObject:
    result = MetaDataLoader().load([FileSource(META_FILE)])
    assert not result.errors, "\n".join(f"{e.code}: {e.message}" for e in result.errors)
    return result.root


def _objects_by_name(root: MetaObject) -> dict[str, MetaObject]:
    return {
        c.name: c
        for c in root.children()
        if c.type == TYPE_OBJECT and isinstance(c, MetaObject)
    }


def _config_dir_for(tmp_path: Path, naming_block: object) -> Path:
    """Write a project's ``.metaobjects/config.json`` declaring *naming_block*
    (``None`` omits the key entirely — the "no naming block" case) and return the
    project directory, for :func:`read_neutral_config` — the SAME reader the CLI's
    load path uses to attach rules to a loaded root.
    """
    raw: dict[str, object] = {"schema_version": 1}
    if naming_block is not None:
        raw["naming"] = naming_block
    dot = tmp_path / ".metaobjects"
    dot.mkdir(parents=True, exist_ok=True)
    (dot / "config.json").write_text(json.dumps(raw), encoding="utf-8")
    return tmp_path


@pytest.mark.parametrize("case", _CASES, ids=lambda c: c["name"])
def test_physical_names_case(case: dict[str, object], tmp_path: Path) -> None:
    config_dir = _config_dir_for(tmp_path, case["naming"])
    cfg = read_neutral_config(config_dir)
    assert cfg is not None
    root = _load_root()
    root.naming = cfg.naming  # type: ignore[attr-defined]
    objects = _objects_by_name(root)

    for obj_name, expected_table in case["tables"].items():  # type: ignore[union-attr]
        obj = objects[obj_name]
        src = primary_rdb_source(obj)
        assert src is not None, f"{obj_name} declares no primary source.rdb"
        assert src.physical_name() == expected_table, (
            f"case {case['name']!r}: {obj_name} table"
        )

    for key, expected_column in case["columns"].items():  # type: ignore[union-attr]
        obj_name, field_name = key.split(".", 1)
        obj = objects[obj_name]
        field = next(f for f in obj.fields() if f.name == field_name)
        assert resolve_column_name(field) == expected_column, (
            f"case {case['name']!r}: {key} column"
        )


@pytest.mark.parametrize("invalid", _INVALID, ids=lambda c: c["name"])
def test_invalid_naming_block_is_refused(invalid: dict[str, object], tmp_path: Path) -> None:
    config_dir = _config_dir_for(tmp_path, invalid["naming"])
    with pytest.raises(ParseError):
        read_neutral_config(config_dir)
