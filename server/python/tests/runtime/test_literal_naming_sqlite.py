"""B1, end to end on SQLite: `naming.columns: literal` in the project's
`.metaobjects/config.json`, found by `load_directory`, makes the ObjectManager read a
table whose columns are the literal field names."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from metaobjects import load_directory
from metaobjects.runtime import ObjectManager, SqliteDriver

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


def _project(tmp_path: Path, naming: dict[str, str]) -> Path:
    (tmp_path / ".metaobjects").mkdir()
    (tmp_path / ".metaobjects" / "config.json").write_text(
        json.dumps({"schema_version": 1, "naming": naming})
    )
    (tmp_path / "metaobjects").mkdir()
    (tmp_path / "metaobjects" / "meta.shop.json").write_text(json.dumps(_META))
    return tmp_path / "metaobjects"


def _db() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.execute('CREATE TABLE "items" ("id" INTEGER PRIMARY KEY, "unitPrice" TEXT)')
    db.execute("INSERT INTO items VALUES (1, 'ten')")
    return db


def test_literal_columns_are_read_through_the_object_manager(tmp_path: Path) -> None:
    meta = _project(tmp_path, {"columns": "literal"})
    om = ObjectManager(load_directory(meta).root, SqliteDriver(_db()))  # type: ignore[arg-type]
    assert om.find_many("Item") == [{"id": 1, "unitPrice": "ten"}]
    assert om.create("Item", {"unitPrice": "five"})["unitPrice"] == "five"


def test_without_the_setting_the_runtime_does_not_read_the_literal_column(tmp_path: Path) -> None:
    meta = _project(tmp_path, {})
    om = ObjectManager(load_directory(meta).root, SqliteDriver(_db()))  # type: ignore[arg-type]
    # SQLite reads an unknown double-quoted identifier as a string literal, so the wrong
    # name does not error: it answers with the name itself, and the stored value is never read.
    assert "ten" not in om.find_many("Item")[0].values()
