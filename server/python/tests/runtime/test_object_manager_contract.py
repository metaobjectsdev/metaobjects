"""The ObjectManager contract (L-PY-1): the abstract class, the DB-API manager that implements it,
transactions and persistence listeners.

``ObjectManager`` is abstract; ``ObjectManagerDb(root, driver)`` is the one for a DB-API
connection. The constructor the previous release took, ``ObjectManager(root, driver)``, is a
clean break with no shim: it fails and says what to construct instead.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from metaobjects import load_directory
from metaobjects.runtime import (
    ObjectManager,
    ObjectManagerDb,
    PersistenceListener,
    SqliteDriver,
)


def _model(tmp_path: Path) -> Any:
    meta = tmp_path / "metaobjects"
    meta.mkdir()
    (meta / "meta.notes.json").write_text(
        json.dumps({
            "metadata.root": {
                "package": "acme::notes",
                "children": [{
                    "object.entity": {
                        "name": "Note",
                        "children": [
                            {"source.rdb": {"@table": "notes"}},
                            {"field.long": {"name": "id"}},
                            {"field.string": {"name": "body"}},
                            {"identity.primary": {"name": "pk", "@fields": ["id"]}},
                        ],
                    }
                }],
            }
        }),
        encoding="utf-8",
    )
    result = load_directory(meta)
    assert [e.code for e in result.errors] == []
    return result.root


def _om(tmp_path: Path) -> tuple[ObjectManagerDb, sqlite3.Connection]:
    conn = sqlite3.connect(":memory:")
    conn.execute('CREATE TABLE "notes" ("id" INTEGER PRIMARY KEY NOT NULL, "body" TEXT)')
    conn.commit()
    return ObjectManagerDb(_model(tmp_path), SqliteDriver(conn)), conn


def _count(conn: sqlite3.Connection) -> int:
    return conn.execute('SELECT COUNT(*) FROM "notes"').fetchone()[0]


# --- the split ---------------------------------------------------------------------------------


def test_the_db_manager_is_an_object_manager(tmp_path: Path) -> None:
    om, _ = _om(tmp_path)
    assert isinstance(om, ObjectManager)
    assert om.create("Note", {"id": 1, "body": "a"}) == {"id": 1, "body": "a"}


def test_the_abstract_class_cannot_be_constructed_and_names_what_to_construct(tmp_path: Path) -> None:
    conn = sqlite3.connect(":memory:")
    with pytest.raises(TypeError, match=r"abstract.*ObjectManagerDb\(root, driver\)"):
        ObjectManager(_model(tmp_path), SqliteDriver(conn))  # type: ignore[abstract, call-arg]


def test_a_manager_for_another_store_is_a_subclass_that_supplies_the_store(tmp_path: Path) -> None:
    class Memory(ObjectManager):
        def __init__(self, root: Any) -> None:
            super().__init__(root)
            self.rows: dict[Any, dict[str, Any]] = {}

        def transaction(self) -> Any:
            raise NotImplementedError

        def find_many(self, entity_name: str, filter: Any = None, *, sort: Any = None,
                      limit: Any = None, offset: Any = None) -> list[dict[str, Any]]:
            return [r for r in self.rows.values() if all(r.get(k) == v for k, v in (filter or {}).items())]

        def count(self, entity_name: str, filter: Any = None) -> int:
            return len(self.find_many(entity_name, filter))

        def relate(self, entity_name: str, record: dict[str, Any], relation_name: str) -> Any:
            return []

        def _insert_row(self, entity: Any, entity_name: str, data: dict[str, Any]) -> dict[str, Any]:
            self.rows[data["id"]] = dict(data)
            return dict(data)

        def _update_row(self, entity: Any, entity_name: str, id_value: Any, data: dict[str, Any],
                        if_missing: str) -> dict[str, Any] | None:
            if id_value not in self.rows:
                return None
            self.rows[id_value].update(data)
            return dict(self.rows[id_value])

        def _delete_row(self, entity: Any, entity_name: str, id_value: Any) -> bool:
            return self.rows.pop(id_value, None) is not None

    om = Memory(_model(tmp_path))
    om.create("Note", {"id": 1, "body": "a"})
    assert om.find_by_id("Note", 1) == {"id": 1, "body": "a"}
    assert om.update("Note", 1, {"body": "b"}) == {"id": 1, "body": "b"}
    assert om.delete("Note", 1) is True
    assert om.find_by_id("Note", 1) is None
    assert om.primary_key_field("Note") == "id"


# --- transactions ------------------------------------------------------------------------------


def test_writes_in_a_transaction_commit_together_when_the_block_ends(tmp_path: Path) -> None:
    om, conn = _om(tmp_path)
    with om.transaction():
        om.create("Note", {"id": 1, "body": "a"})
        om.create("Note", {"id": 2, "body": "b"})
        assert conn.in_transaction  # held open, not committed per write
        assert om.count("Note") == 2  # and visible to a read inside the block
    assert not conn.in_transaction
    assert _count(conn) == 2


def test_an_exception_rolls_back_every_write_in_the_block(tmp_path: Path) -> None:
    om, conn = _om(tmp_path)
    om.create("Note", {"id": 1, "body": "kept"})
    with pytest.raises(RuntimeError, match="boom"):
        with om.transaction():
            om.create("Note", {"id": 2, "body": "lost"})
            om.update("Note", 1, {"body": "changed"})
            om.delete("Note", 1)
            raise RuntimeError("boom")
    assert [r["body"] for r in om.find_many("Note")] == ["kept"]


def test_a_nested_block_joins_the_outer_one(tmp_path: Path) -> None:
    om, conn = _om(tmp_path)
    with om.transaction():
        with om.transaction():
            om.create("Note", {"id": 1, "body": "a"})
        assert conn.in_transaction  # the inner block's end did not commit
    assert _count(conn) == 1
    with pytest.raises(RuntimeError):
        with om.transaction():
            with om.transaction():
                om.create("Note", {"id": 2, "body": "b"})
            raise RuntimeError("outer fails after inner succeeded")
    assert _count(conn) == 1


def test_a_write_outside_a_block_still_commits_on_its_own(tmp_path: Path) -> None:
    om, conn = _om(tmp_path)
    om.create("Note", {"id": 1, "body": "a"})
    assert not conn.in_transaction
    assert _count(conn) == 1


def test_the_transaction_is_reusable_after_a_rollback(tmp_path: Path) -> None:
    om, conn = _om(tmp_path)
    with pytest.raises(ValueError):
        with om.transaction():
            om.create("Note", {"id": 1, "body": "a"})
            raise ValueError
    with om.transaction():
        om.create("Note", {"id": 1, "body": "again"})
    assert om.find_by_id("Note", 1) == {"id": 1, "body": "again"}


# --- listeners ---------------------------------------------------------------------------------


class Recording(PersistenceListener):
    def __init__(self) -> None:
        self.events: list[tuple[Any, ...]] = []

    def on_before_create(self, entity_name: str, data: dict[str, Any]) -> None:
        self.events.append(("before_create", entity_name, dict(data)))

    def on_after_create(self, entity_name: str, row: dict[str, Any]) -> None:
        self.events.append(("after_create", entity_name, dict(row)))

    def on_before_update(self, entity_name: str, id_value: Any, data: dict[str, Any]) -> None:
        self.events.append(("before_update", entity_name, id_value, dict(data)))

    def on_after_update(self, entity_name: str, id_value: Any, row: dict[str, Any]) -> None:
        self.events.append(("after_update", entity_name, id_value, dict(row)))

    def on_before_delete(self, entity_name: str, id_value: Any) -> None:
        self.events.append(("before_delete", entity_name, id_value))

    def on_after_delete(self, entity_name: str, id_value: Any) -> None:
        self.events.append(("after_delete", entity_name, id_value))


def test_listeners_see_each_write_before_and_after(tmp_path: Path) -> None:
    om, _ = _om(tmp_path)
    rec = Recording()
    om.add_listener(rec)
    om.create("Note", {"id": 1, "body": "a"})
    om.update("Note", 1, {"body": "b"})
    om.delete("Note", 1)
    assert rec.events == [
        ("before_create", "Note", {"id": 1, "body": "a"}),
        ("after_create", "Note", {"id": 1, "body": "a"}),
        ("before_update", "Note", 1, {"body": "b"}),
        ("after_update", "Note", 1, {"id": 1, "body": "b"}),
        ("before_delete", "Note", 1),
        ("after_delete", "Note", 1),
    ]


def test_insert_preserving_notifies_as_a_create(tmp_path: Path) -> None:
    om, _ = _om(tmp_path)
    rec = Recording()
    om.add_listener(rec)
    om.insert_preserving("Note", {"id": 1, "body": "a"})
    assert [e[0] for e in rec.events] == ["before_create", "after_create"]


def test_after_events_are_not_sent_when_nothing_matched(tmp_path: Path) -> None:
    om, _ = _om(tmp_path)
    rec = Recording()
    om.add_listener(rec)
    assert om.update("Note", 99, {"body": "x"}) is None
    assert om.delete("Note", 99) is False
    assert [e[0] for e in rec.events] == ["before_update", "before_delete"]


def test_a_before_listener_can_refuse_the_write(tmp_path: Path) -> None:
    om, conn = _om(tmp_path)

    class Veto(PersistenceListener):
        def on_before_create(self, entity_name: str, data: dict[str, Any]) -> None:
            raise PermissionError("not today")

    om.add_listener(Veto())
    with pytest.raises(PermissionError):
        om.create("Note", {"id": 1, "body": "a"})
    assert _count(conn) == 0


def test_an_after_listener_failing_inside_a_transaction_rolls_it_back(tmp_path: Path) -> None:
    om, conn = _om(tmp_path)

    class Audit(PersistenceListener):
        def on_after_create(self, entity_name: str, row: dict[str, Any]) -> None:
            if row["id"] == 2:
                raise RuntimeError("audit store down")

    om.add_listener(Audit())
    with pytest.raises(RuntimeError, match="audit store down"):
        with om.transaction():
            om.create("Note", {"id": 1, "body": "a"})
            om.create("Note", {"id": 2, "body": "b"})
    assert _count(conn) == 0


def test_a_removed_listener_hears_nothing_more(tmp_path: Path) -> None:
    om, _ = _om(tmp_path)
    rec = Recording()
    om.add_listener(rec)
    om.remove_listener(rec)
    om.remove_listener(rec)  # removing one that is not registered is ignored
    om.create("Note", {"id": 1, "body": "a"})
    assert rec.events == []


def test_an_unknown_entity_is_refused_before_any_listener_hears_of_it(tmp_path: Path) -> None:
    om, _ = _om(tmp_path)
    rec = Recording()
    om.add_listener(rec)
    with pytest.raises(KeyError):
        om.create("Nobody", {"id": 1})
    assert rec.events == []
