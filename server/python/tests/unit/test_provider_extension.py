"""Provider-extension tests — Python parity with TS sdk/test/memory-providers.test.ts.

Verifies the cross-port provider-extension contract:
  - composing a custom provider on top of the core provider registers
    the new subtype AND keeps the core subtypes recognized.
  - duplicate ids / missing deps / cycles surface the stable error
    codes via ``compose_registry`` / ``MetaDataLoader.from_directory``.

The Python port's loader entry already takes a ``providers`` arg
(``MetaDataLoader.from_directory(dir, providers=...)``); these tests
exercise that end-to-end the same way the TS sdk's loadMemory tests do.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects import MetaDataLoader
from metaobjects.core_types import core_provider
from metaobjects.errors import ErrorCode, ParseError
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.provider import Provider
from metaobjects.registry import TypeDefinition


def _geo_provider() -> Provider:
    """A minimal third-party provider that registers a new field subtype."""
    p = Provider("test-geo", dependencies=("metaobjects-core-types",))
    p.add(
        TypeDefinition(
            type="field",
            sub_type="geopoint",
            factory=lambda t, s, n: MetaField(t, s, n),
        )
    )
    return p


def _write_metadata(tmp_path: Path, content: dict) -> Path:
    meta_dir = tmp_path / "metaobjects"
    meta_dir.mkdir(exist_ok=True)
    (meta_dir / "domain.json").write_text(json.dumps(content))
    return meta_dir


def test_custom_provider_on_top_of_core_registers_new_subtype(tmp_path: Path) -> None:
    meta_dir = _write_metadata(
        tmp_path,
        {
            "metadata.root": {
                "package": "test",
                "children": [
                    {
                        "object.entity": {
                            "name": "Place",
                            "children": [
                                {"field.geopoint": {"name": "location"}}
                            ],
                        }
                    }
                ],
            }
        },
    )
    result = MetaDataLoader.from_directory(
        meta_dir, providers=[core_provider, _geo_provider()]
    )
    assert result.errors == []
    # Walk the tree: root → object Place → field location with subType geopoint.
    objs = [c for c in result.root.children() if c.name == "Place"]
    assert len(objs) == 1
    fields = [c for c in objs[0].children() if c.name == "location"]
    assert len(fields) == 1
    assert fields[0].sub_type == "geopoint"


def test_custom_provider_does_not_break_default_core_subtypes(tmp_path: Path) -> None:
    meta_dir = _write_metadata(
        tmp_path,
        {
            "metadata.root": {
                "package": "test",
                "children": [
                    {
                        "object.entity": {
                            "name": "User",
                            "children": [
                                {"field.string": {"name": "email"}}
                            ],
                        }
                    }
                ],
            }
        },
    )
    result = MetaDataLoader.from_directory(
        meta_dir, providers=[core_provider, _geo_provider()]
    )
    assert result.errors == []
    users = [c for c in result.root.children() if c.name == "User"]
    assert len(users) == 1
    emails = [c for c in users[0].children() if c.name == "email"]
    assert len(emails) == 1
    assert emails[0].sub_type == "string"


def test_duplicate_provider_id_surfaces_stable_code(tmp_path: Path) -> None:
    """ERR_PROVIDER_DUPLICATE_ID — same code Java/TS/C# emit."""
    meta_dir = _write_metadata(tmp_path, {"metadata.root": {"children": []}})
    dup1 = Provider("test-dup")
    dup2 = Provider("test-dup")
    with pytest.raises(ParseError) as exc:
        MetaDataLoader.from_directory(meta_dir, providers=[dup1, dup2])
    assert exc.value.code is ErrorCode.ERR_PROVIDER_DUPLICATE_ID


def test_missing_dependency_surfaces_stable_code(tmp_path: Path) -> None:
    """ERR_PROVIDER_MISSING_DEPENDENCY — same code Java/TS/C# emit."""
    meta_dir = _write_metadata(tmp_path, {"metadata.root": {"children": []}})
    needs = Provider("test-needs-x", dependencies=("does-not-exist",))
    with pytest.raises(ParseError) as exc:
        MetaDataLoader.from_directory(meta_dir, providers=[needs])
    assert exc.value.code is ErrorCode.ERR_PROVIDER_MISSING_DEPENDENCY


def test_dependency_cycle_surfaces_stable_code(tmp_path: Path) -> None:
    """ERR_PROVIDER_DEPENDENCY_CYCLE — same code Java/TS/C# emit."""
    meta_dir = _write_metadata(tmp_path, {"metadata.root": {"children": []}})
    a = Provider("cycle-a", dependencies=("cycle-b",))
    b = Provider("cycle-b", dependencies=("cycle-a",))
    with pytest.raises(ParseError) as exc:
        MetaDataLoader.from_directory(meta_dir, providers=[a, b])
    assert exc.value.code is ErrorCode.ERR_PROVIDER_DEPENDENCY_CYCLE
