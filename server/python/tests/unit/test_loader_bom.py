"""Unit tests for UTF-8 BOM stripping in the metadata file loader (porting-guide §3)."""
from __future__ import annotations

import json
from pathlib import Path

from metaobjects.errors import ErrorCode
from metaobjects.loader.meta_data_loader import load_directory


def _minimal_root_json() -> str:
    """Return a minimal valid metadata.root document as a JSON string."""
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Item",
                        "children": [
                            {"field.long": {"name": "id"}},
                            {"identity.primary": {"@fields": "id"}},
                        ],
                    }
                }
            ],
        }
    }
    return json.dumps(doc)


def test_bom_prefixed_file_does_not_produce_malformed_json_error(tmp_path: Path) -> None:
    """A JSON file with a leading UTF-8 BOM (U+FEFF) must load without ERR_MALFORMED_JSON.

    Java tooling sometimes writes JSON files with a UTF-8 BOM; the porting guide
    (§3) requires all loaders to strip it before parsing so cross-authored files
    round-trip cleanly.
    """
    bom = "﻿"
    bom_file = tmp_path / "meta.items.json"
    bom_file.write_text(bom + _minimal_root_json(), encoding="utf-8")

    result = load_directory(str(tmp_path))

    malformed = [e for e in result.errors if e.code == ErrorCode.ERR_MALFORMED_JSON]
    assert not malformed, (
        f"Expected no ERR_MALFORMED_JSON for a BOM-prefixed file, got: {malformed}"
    )


def test_bom_prefixed_file_parses_entity(tmp_path: Path) -> None:
    """A JSON file with a leading BOM must parse its entity correctly after stripping."""
    bom = "﻿"
    bom_file = tmp_path / "meta.items.json"
    bom_file.write_text(bom + _minimal_root_json(), encoding="utf-8")

    result = load_directory(str(tmp_path))

    assert not result.errors, f"Unexpected errors: {result.errors}"
    entity_names = [c.name for c in result.root.children() if c.name]
    assert "Item" in entity_names, f"Expected 'Item' entity; found: {entity_names}"


def test_file_without_bom_still_loads(tmp_path: Path) -> None:
    """A normal file without a BOM must continue to load correctly (regression guard)."""
    plain_file = tmp_path / "meta.items.json"
    plain_file.write_text(_minimal_root_json(), encoding="utf-8")

    result = load_directory(str(tmp_path))

    assert not result.errors, f"Unexpected errors: {result.errors}"
