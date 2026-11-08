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
from metaobjects.meta.core.field.field_constants import FIELD_ATTR_OBJECT_REF
from metaobjects.naming import resolve_column_name, resolve_flattened_column_name
from metaobjects.naming_refs import ref_target
from metaobjects.shared.base_types import TYPE_OBJECT
from metaobjects.source_resolution import primary_rdb_source
from tests.conformance.naming_corpus import register_corpus_strategies

REPO = Path(__file__).parents[4]
CORPUS = REPO / "fixtures" / "naming-conformance" / "physical-names"
CASES_FILE = CORPUS / "cases.json"
META_FILE = CORPUS / "meta.naming.json"

_SPEC = json.loads(CASES_FILE.read_text())
_CASES: list[dict[str, object]] = _SPEC["cases"]
_INVALID: list[dict[str, object]] = _SPEC["invalid"]

# The corpus's application-registered strategies, before any block is read.

@pytest.fixture(autouse=True)
def _corpus_strategies() -> None:
    # Per test, not once at import: the registry is process-wide, and a test elsewhere in the
    # session may reset it (reset_naming_strategies_for_testing) after this module is collected.
    register_corpus_strategies()


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
        obj_name, field_name, *member_name = key.split(".", 2)
        obj = objects[obj_name]
        field = next(f for f in obj.fields() if f.name == field_name)
        if not member_name:
            actual = resolve_column_name(field)
        else:
            # `<Object>.<field>.<member>`: a member of the flattened value object the field
            # embeds, named by core naming.
            target = ref_target(field, FIELD_ATTR_OBJECT_REF)
            assert isinstance(target, MetaObject), f"{key}: @objectRef does not resolve"
            member = next(f for f in target.fields() if f.name == member_name[0])
            actual = resolve_flattened_column_name(field, member)
        assert actual == expected_column, f"case {case['name']!r}: {key} column"


@pytest.mark.parametrize("invalid", _INVALID, ids=lambda c: c["name"])
def test_invalid_naming_block_is_refused(invalid: dict[str, object], tmp_path: Path) -> None:
    config_dir = _config_dir_for(tmp_path, invalid["naming"])
    with pytest.raises(ParseError) as raised:
        read_neutral_config(config_dir)
    includes: list[str] = invalid.get("messageIncludes", [])  # type: ignore[assignment]
    for part in includes:
        assert part in str(raised.value), str(raised.value)
    if includes:
        assert "Python port" in str(raised.value)
