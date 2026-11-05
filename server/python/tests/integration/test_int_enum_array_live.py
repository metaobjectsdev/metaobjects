"""An int-backed ``field.enum`` ARRAY on a live Postgres: the stored elements are ints.

The unit tests pin the codec in isolation; this drives the real ``ObjectManager`` and pg8000
against an ``integer[]`` column and reads the RAW column back, so the failure mode the old
load-time refusal guarded against (member symbols persisted into the array) cannot hide behind a
codec that only round-trips with itself.

The map is inherited from a shared abstract enum that a scalar column also uses, which is the
shape that makes the array form necessary: one map on the shared enum, scalar and array consumers.

SQLite and MySQL are not covered: this port's runtime has no primitive-array persistence on either
engine (no list case in ``SqliteDialect.encode_param`` / ``MySqlDialect.encode_param``), for any
element type, so there is nothing for the int-backed form to change there.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import closing
from typing import Any

import pg8000.dbapi as pg8000
import pytest

from metaobjects import load_string
from metaobjects.runtime import ObjectManager, PostgresDriver

from .postgres_container import PostgresContainer

_META = {
    "metadata.root": {
        "package": "acme::orders",
        "children": [
            {"field.enum": {
                "name": "Status", "abstract": True,
                "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"],
                "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9},
            }},
            {"object.entity": {
                "name": "Order",
                "children": [
                    {"source.rdb": {"@table": "orders"}},
                    {"field.long": {"name": "id"}},
                    {"field.enum": {"name": "status", "extends": "acme::orders::Status"}},
                    {"field.enum": {"name": "history", "extends": "acme::orders::Status", "isArray": True}},
                    {"identity.primary": {"name": "pk", "@fields": ["id"]}},
                ],
            }},
        ],
    }
}

# No CHECK on the array column: membership of an enum array stays app-level.
_DDL = 'CREATE TABLE "orders" ("id" BIGINT PRIMARY KEY, "status" INTEGER, "history" INTEGER[])'


@pytest.fixture
def pg() -> Iterator[tuple[ObjectManager, Any]]:
    with PostgresContainer() as container:
        info = container.info()
        with closing(pg8000.connect(
            host=info.host, port=info.port, user=info.user, password=info.password,
            database=info.database,
        )) as conn:
            cur = conn.cursor()
            cur.execute(_DDL)
            conn.commit()
            result = load_string(json.dumps(_META))
            assert result.errors == [], result.errors
            yield ObjectManager(result.root, PostgresDriver(conn)), conn


def _raw(conn: Any, id_value: int) -> Any:
    cur = conn.cursor()
    cur.execute('SELECT "history", pg_typeof("history")::text FROM "orders" WHERE "id" = %s', (id_value,))
    history, sql_type = cur.fetchone()
    assert sql_type == "integer[]"
    return history


def test_int_backed_enum_array_round_trips_and_stores_ints(pg: tuple[ObjectManager, Any]) -> None:
    om, conn = pg

    created = om.create("Order", {"id": 1, "status": "PUBLISHED", "history": ["PUBLISHED", "DRAFT"]})
    assert created["history"] == ["PUBLISHED", "DRAFT"]
    assert created["status"] == "PUBLISHED"
    om.create("Order", {"id": 2, "history": []})
    om.create("Order", {"id": 3, "history": None})

    # The raw column holds the declared ints, in order, never the symbols.
    stored = _raw(conn, 1)
    assert stored == [5, 0]
    assert all(type(v) is int for v in stored)
    assert _raw(conn, 2) == []
    assert _raw(conn, 3) is None

    # Read back as members: empty stays empty, null stays null.
    assert om.find_by_id("Order", 1)["history"] == ["PUBLISHED", "DRAFT"]
    assert om.find_by_id("Order", 2)["history"] == []
    assert om.find_by_id("Order", 3)["history"] is None

    updated = om.update("Order", 2, {"history": ["ARCHIVED", "DRAFT", "ARCHIVED"]})
    assert updated is not None and updated["history"] == ["ARCHIVED", "DRAFT", "ARCHIVED"]
    assert _raw(conn, 2) == [9, 0, 9]

    # A whole-array equality filter binds the encoded ints.
    rows = om.find_many("Order", {"history": {"eq": ["PUBLISHED", "DRAFT"]}})
    assert [r["id"] for r in rows] == [1]


def test_an_unmapped_stored_element_fails_the_read(pg: tuple[ObjectManager, Any]) -> None:
    om, conn = pg
    cur = conn.cursor()
    cur.execute('INSERT INTO "orders" ("id", "history") VALUES (1, \'{0,7}\')')
    conn.commit()
    with pytest.raises(ValueError, match="7"):
        om.find_by_id("Order", 1)
