"""The ObjectManager on SQLite and MySQL: the SQL each driver's dialect emits, and the values
it decodes.

SQLite runs for real (stdlib ``sqlite3``, in memory) with a recording connection wrapped around
it. MySQL has no embedded engine, so a scripted double stands in for PyMySQL and the assertions
are on the SQL and the parameters it was handed; the live MySQL lane is
``tests/integration/test_query_scenarios.py`` and ``test_api_contract_report.py``.
"""
from __future__ import annotations

import datetime as dt
import decimal
import json
import sqlite3
import uuid
from typing import Any

import pytest

from metaobjects import load_string
from metaobjects.naming import NamingRules
from metaobjects.runtime import (
    MYSQL,
    POSTGRES,
    SQLITE,
    MySqlDriver,
    ObjectManager,
    PostgresDriver,
    SqliteDriver,
)

_META = {
    "metadata.root": {
        "package": "acme::shop",
        "children": [
            {
                "object.entity": {
                    "name": "Item",
                    "children": [
                        {"source.rdb": {"@table": "items"}},
                        {"field.long": {"name": "id"}},
                        {"field.string": {"name": "label", "@required": True}},
                        {"field.int": {"name": "qty"}},
                        {"field.boolean": {"name": "active"}},
                        {"field.decimal": {"name": "price", "@precision": 9, "@scale": 2}},
                        {"field.uuid": {"name": "ref"}},
                        {"field.date": {"name": "madeOn"}},
                        {"field.timestamp": {"name": "seenAt"}},
                        {"identity.primary": {"name": "pk", "@fields": ["id"], "@generation": "increment"}},
                    ],
                }
            }
        ],
    }
}


def _root() -> Any:
    root = load_string(json.dumps(_META)).root
    root.naming = NamingRules(columns="literal")
    return root


class Recording:
    """A DB-API connection that records every statement and delegates to a real one."""

    def __init__(self, real: Any) -> None:
        self.real = real
        self.sql: list[tuple[str, tuple[Any, ...]]] = []

    def cursor(self) -> Any:
        outer = self
        cur = self.real.cursor()

        class _Cur:
            def execute(self, sql: str, params: tuple[Any, ...] = ()) -> Any:
                outer.sql.append((sql, tuple(params)))
                return cur.execute(sql, params)

            def __getattr__(self, name: str) -> Any:
                return getattr(cur, name)

        return _Cur()

    def commit(self) -> None:
        self.real.commit()

    def close(self) -> None:
        self.real.close()


_SQLITE_DDL = (
    'CREATE TABLE "items" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "label" TEXT NOT NULL, '
    '"qty" INTEGER, "active" INTEGER, "price" NUMERIC, "ref" TEXT, "madeOn" TEXT, "seenAt" TEXT)'
)


def _sqlite_om() -> tuple[ObjectManager, Recording]:
    real = sqlite3.connect(":memory:")
    real.execute(_SQLITE_DDL)
    rec = Recording(real)
    return ObjectManager(_root(), SqliteDriver(rec)), rec  # type: ignore[arg-type]


# ----------------------------------------------------------------------------
# SQLite: emitted SQL and a real round trip
# ----------------------------------------------------------------------------


def test_sqlite_read_uses_qmark_placeholders_and_double_quotes() -> None:
    om, rec = _sqlite_om()
    om.find_many("Item", {"qty": {"gte": 2}, "label": "a"}, sort=[("qty", "desc")], limit=5, offset=10)
    sql, params = rec.sql[-1]
    assert sql == (
        'SELECT "id", "label", "qty", "active", "price", "ref", "madeOn", "seenAt" FROM "items" '
        'WHERE "qty" >= ? AND "label" = ? ORDER BY "qty" DESC NULLS FIRST LIMIT 5 OFFSET 10'
    )
    assert params == (2, "a")


def test_sqlite_offset_without_limit_adds_an_unbounded_limit() -> None:
    om, rec = _sqlite_om()
    om.find_many("Item", offset=3)
    assert rec.sql[-1][0].endswith("LIMIT -1 OFFSET 3")


def test_sqlite_like_is_case_sensitive_through_glob() -> None:
    om, rec = _sqlite_om()
    om.create("Item", {"label": "Alpha"})
    om.create("Item", {"label": "alpha"})
    om.create("Item", {"label": "a*b"})
    assert [r["label"] for r in om.find_many("Item", {"label": {"like": "A%"}})] == ["Alpha"]
    # `*` in the pattern is a literal, not GLOB's wildcard
    assert [r["label"] for r in om.find_many("Item", {"label": {"like": "a*_"}})] == ["a*b"]
    assert 'GLOB ?' in rec.sql[-1][0]


def test_sqlite_empty_in_matches_nothing() -> None:
    om, rec = _sqlite_om()
    om.create("Item", {"label": "x"})
    assert om.find_many("Item", {"id": {"in": []}}) == []
    assert "0 = 1" in rec.sql[-1][0]


def test_sqlite_write_path_returns_the_row_decoded_to_declared_types() -> None:
    om, rec = _sqlite_om()
    created = om.create(
        "Item",
        {
            "label": "pen", "qty": 3, "active": True, "price": "12.50",
            "ref": "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "madeOn": "2026-05-01",
            "seenAt": "2026-05-04T03:30:00Z",
        },
    )
    assert rec.sql[0][0].startswith('INSERT INTO "items"') and "RETURNING" in rec.sql[0][0]
    assert created["active"] is True
    assert created["price"] == decimal.Decimal("12.5")
    assert created["ref"] == uuid.UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    assert created["madeOn"] == dt.date(2026, 5, 1)
    assert created["seenAt"] == dt.datetime(2026, 5, 4, 3, 30, tzinfo=dt.timezone.utc)
    # what was BOUND is the engine's spelling, not a Python object sqlite3 would mis-adapt
    _, params = rec.sql[0]
    assert "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" in params
    assert "2026-05-04T03:30:00.000Z" in params
    assert "2026-05-01" in params
    assert 12.5 in params

    updated = om.update("Item", created["id"], {"active": False, "qty": 4})
    assert updated is not None and updated["active"] is False and updated["qty"] == 4
    assert om.update("Item", 999, {"qty": 1}) is None
    assert om.delete("Item", created["id"]) is True
    assert om.delete("Item", created["id"]) is False


def test_sqlite_without_returning_rereads_by_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """SQLite older than 3.35 has no RETURNING: the write path inserts, then reads by key."""
    monkeypatch.setattr("metaobjects.runtime.dialect.sqlite_supports_returning", lambda: False)
    om, rec = _sqlite_om()
    created = om.create("Item", {"label": "pen", "qty": 1})
    assert created["id"] == 1 and created["label"] == "pen"
    assert not any("RETURNING" in sql for sql, _ in rec.sql)
    assert rec.sql[-1][0].startswith('SELECT "id", "label"')
    updated = om.update("Item", 1, {"qty": 2})
    assert updated is not None and updated["qty"] == 2
    assert om.update("Item", 7, {"qty": 2}) is None


def test_sqlite_type_codes_follow_the_declared_subtype() -> None:
    om, _ = _sqlite_om()
    om.create("Item", {"label": "x", "qty": 1})
    om.find_many("Item")
    # long -> int8 (a BIGINT on the wire is a string); int -> int4 (stays a number)
    assert om.last_column_oids["id"] == 20
    assert om.last_column_oids["qty"] == 23
    assert "label" not in om.last_column_oids


# ----------------------------------------------------------------------------
# MySQL: a scripted PyMySQL double
# ----------------------------------------------------------------------------


class _MyCursor:
    def __init__(self, conn: "FakeMySql") -> None:
        self._conn = conn
        self.description: Any = None
        self.rowcount = 0
        self.lastrowid = 0
        self._rows: list[tuple[Any, ...]] = []

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> None:
        self._conn.sql.append((sql, tuple(params)))
        columns, rows, rowcount, lastrowid = self._conn.script(sql)
        self.description = [(c, None, None, None, None, None, None) for c in columns]
        self._rows = rows
        self.rowcount = rowcount
        self.lastrowid = lastrowid

    def fetchall(self) -> list[tuple[Any, ...]]:
        return self._rows

    def close(self) -> None:
        pass


class FakeMySql:
    def __init__(self) -> None:
        self.sql: list[tuple[str, tuple[Any, ...]]] = []
        self.row: tuple[Any, ...] | None = None
        self.update_rowcount = 1
        self.insert_id = 42

    COLS = ["id", "label", "qty", "active", "price", "ref", "madeOn", "seenAt"]

    def script(self, sql: str) -> tuple[list[str], list[tuple[Any, ...]], int, int]:
        if sql.startswith("INSERT"):
            return [], [], 1, self.insert_id
        if sql.startswith(("UPDATE", "DELETE")):
            return [], [], self.update_rowcount, 0
        if sql.startswith("SELECT COUNT"):
            return ["COUNT(*)"], [(7,)], 0, 0
        return self.COLS, [self.row] if self.row else [], 0, 0

    def cursor(self) -> _MyCursor:
        return _MyCursor(self)

    def commit(self) -> None:
        pass

    def close(self) -> None:
        pass


def _mysql_om() -> tuple[ObjectManager, FakeMySql]:
    conn = FakeMySql()
    conn.row = (42, "pen", 3, 1, decimal.Decimal("12.50"), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                dt.date(2026, 5, 1), dt.datetime(2026, 5, 4, 3, 30))
    return ObjectManager(_root(), MySqlDriver(conn)), conn  # type: ignore[arg-type]


def test_mysql_read_uses_backticks_and_percent_placeholders() -> None:
    om, conn = _mysql_om()
    om.find_many("Item", {"qty": {"gte": 2}, "label": {"like": "A%"}}, sort=[("qty", "asc")], offset=4)
    sql, params = conn.sql[-1]
    assert sql == (
        "SELECT `id`, `label`, `qty`, `active`, `price`, `ref`, `madeOn`, `seenAt` FROM `items` "
        "WHERE `qty` >= %s AND `label` LIKE BINARY %s ORDER BY (`qty` IS NULL) ASC, `qty` ASC "
        "LIMIT 18446744073709551615 OFFSET 4"
    )
    assert params == (2, "A%")
    assert '"' not in sql  # never relies on ANSI_QUOTES


def test_mysql_count_and_empty_in() -> None:
    om, conn = _mysql_om()
    assert om.count("Item", {"id": {"in": []}}) == 7
    assert conn.sql[-1][0] == "SELECT COUNT(*) FROM `items` WHERE FALSE"


def test_mysql_decodes_to_declared_types() -> None:
    om, _ = _mysql_om()
    (row,) = om.find_many("Item")
    assert row["active"] is True
    assert row["price"] == decimal.Decimal("12.50")
    assert row["ref"] == uuid.UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    assert row["seenAt"] == dt.datetime(2026, 5, 4, 3, 30, tzinfo=dt.timezone.utc)  # a DATETIME is UTC


def test_mysql_create_inserts_then_rereads_by_the_generated_key() -> None:
    om, conn = _mysql_om()
    created = om.create("Item", {"label": "pen"})
    insert, select = conn.sql[0], conn.sql[1]
    assert insert[0] == "INSERT INTO `items` (`label`) VALUES (%s)"
    assert "RETURNING" not in insert[0]
    assert select == (
        "SELECT `id`, `label`, `qty`, `active`, `price`, `ref`, `madeOn`, `seenAt` "
        "FROM `items` WHERE `id` = %s",
        (42,),
    )
    assert created["id"] == 42 and created["label"] == "pen"


def test_mysql_create_with_a_supplied_key_rereads_by_it() -> None:
    om, conn = _mysql_om()
    conn.insert_id = 0
    om.create("Item", {"id": 9, "label": "pen"})
    assert conn.sql[1][1] == (9,)


def test_mysql_create_with_no_key_at_all_is_refused() -> None:
    om, conn = _mysql_om()
    conn.insert_id = 0
    with pytest.raises(ValueError, match="supply a value for 'id'"):
        om.create("Item", {"label": "pen"})


def test_mysql_default_values_insert() -> None:
    om, conn = _mysql_om()
    om.create("Item", {})
    assert conn.sql[0][0] == "INSERT INTO `items` () VALUES ()"


def test_mysql_update_reads_back_even_when_nothing_changed() -> None:
    om, conn = _mysql_om()
    conn.update_rowcount = 0  # MySQL reports CHANGED rows, so a no-op update reads as 0
    updated = om.update("Item", 42, {"qty": 3})
    assert updated is not None and updated["id"] == 42
    assert conn.sql[0][0] == "UPDATE `items` SET `qty` = %s WHERE `id` = %s"
    assert conn.sql[1][0].startswith("SELECT `id`")


def test_mysql_update_of_a_missing_row_is_none() -> None:
    om, conn = _mysql_om()
    conn.row = None
    assert om.update("Item", 1, {"qty": 3}) is None
    with pytest.raises(KeyError):
        om.update("Item", 1, {"qty": 3}, if_missing="throw")


def test_mysql_delete_counts_rows() -> None:
    om, conn = _mysql_om()
    assert om.delete("Item", 1) is True
    assert conn.sql[-1][0] == "DELETE FROM `items` WHERE `id` = %s"
    conn.update_rowcount = 0
    assert om.delete("Item", 1) is False


def test_postgres_is_unchanged() -> None:
    class Conn(FakeMySql):
        pass

    conn = Conn()
    om = ObjectManager(_root(), PostgresDriver(conn))  # type: ignore[arg-type]
    om.find_many("Item", {"label": {"like": "A%"}}, limit=1)
    assert conn.sql[-1][0] == (
        'SELECT "id", "label", "qty", "active", "price", "ref", "madeOn", "seenAt" FROM "items" '
        'WHERE "label" LIKE %s LIMIT 1'
    )


# ----------------------------------------------------------------------------
# Dialect value hooks and the shared pieces
# ----------------------------------------------------------------------------


def test_identifier_quoting_refuses_the_quote_character() -> None:
    with pytest.raises(ValueError):
        POSTGRES.quote('a"b')
    with pytest.raises(ValueError):
        SQLITE.quote('a"b')
    with pytest.raises(ValueError):
        MYSQL.quote("a`b")
    assert MYSQL.quote('a"b') == '`a"b`'


def test_mysql_binds_an_aware_datetime_as_the_utc_wall_clock() -> None:
    aware = dt.datetime(2026, 5, 4, 5, 30, tzinfo=dt.timezone(dt.timedelta(hours=2)))
    assert MYSQL.encode_param(aware) == dt.datetime(2026, 5, 4, 3, 30)
    assert MYSQL.encode_param(uuid.UUID(int=1)) == "00000000-0000-0000-0000-000000000001"


def test_sqlite_binds_the_engines_spelling() -> None:
    assert SQLITE.encode_param(True) == 1
    assert SQLITE.encode_param(decimal.Decimal("3")) == 3
    assert SQLITE.encode_param(decimal.Decimal("0.5")) == 0.5
    assert SQLITE.encode_param(dt.datetime(2026, 5, 4, 3, 30)) == "2026-05-04T03:30:00.000"
    assert SQLITE.encode_param(dt.time(1, 2, 3)) == "01:02:03"


def test_a_filter_operand_given_as_text_is_typed_by_the_field() -> None:
    from metaobjects.runtime.object_manager import _compile_filter

    root = _root()
    item = next(c for c in root.own_children() if c.name == "Item")
    sql, params = _compile_filter(
        {"qty": {"gt": "2"}, "active": "true", "price": {"in": ["1.5", "2"]}, "label": {"eq": "7"}},
        item, "literal", SQLITE,
    ) or ("", [])
    assert sql == '"qty" > ? AND "active" = ? AND "price" IN (?, ?) AND "label" = ?'
    assert params == [2, True, decimal.Decimal("1.5"), decimal.Decimal("2"), "7"]


def test_a_mysql_decimal_operand_is_cast_to_a_decimal() -> None:
    """ADR-0019 W2: MySQL compares DECIMAL = 'text' as doubles, so the operand is cast."""
    from decimal import Decimal

    from metaobjects.meta.core.field.meta_field import MetaField
    from metaobjects.runtime.dialect import MYSQL, POSTGRES
    from metaobjects.runtime.object_manager import _op_clause
    from metaobjects.shared.base_types import TYPE_FIELD

    f = MetaField(TYPE_FIELD, "decimal", "amount")
    sql, params = _op_clause("amount", "eq", Decimal("1.5"), f, MYSQL)
    assert sql == "`amount` = CAST(%s AS DECIMAL(65,30))" and params == [Decimal("1.5")]
    sql, _ = _op_clause("amount", "in", [Decimal("1"), Decimal("2")], f, MYSQL)
    assert sql.count("CAST(%s AS DECIMAL(65,30))") == 2
    assert _op_clause("amount", "eq", Decimal("1.5"), f, POSTGRES)[0] == '"amount" = %s'
