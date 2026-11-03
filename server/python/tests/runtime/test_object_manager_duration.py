"""field.duration through the ObjectManager: the write codec (an accepted ISO-8601 string becomes a
``timedelta``; anything else is refused), the per-engine binding (pg8000 binds the ``timedelta``
as an interval, SQLite and MySQL a TEXT column holding the canonical string) and the read codec
(every engine reads back a ``timedelta``; an interval with a month part is refused).

The live Postgres lane is ``tests/integration/test_query_scenarios.py``
(``roundtrip-all-types``, ``update-delete-all-types``).
"""
from __future__ import annotations

import datetime as dt
import json
import sqlite3
from typing import Any

import pytest

from metaobjects import load_string
from metaobjects.naming import NamingRules
from metaobjects.runtime import MYSQL, POSTGRES, SQLITE, ObjectManager, SqliteDriver
from metaobjects.runtime.dialect import DurationParam
from metaobjects.runtime.object_manager import _coerce_write_value, _decode_read_value

_META = {
    "metadata.root": {
        "package": "acme::ops",
        "children": [
            {
                "object.entity": {
                    "name": "Hold",
                    "children": [
                        {"source.rdb": {"@table": "holds"}},
                        {"field.long": {"name": "id"}},
                        {"field.duration": {"name": "holdFor"}},
                        {"field.duration": {"name": "steps", "isArray": True}},
                        {"identity.primary": {"name": "pk", "@fields": ["id"], "@generation": "increment"}},
                    ],
                }
            }
        ],
    }
}


def _root() -> Any:
    root: Any = load_string(json.dumps(_META)).root
    root.naming = NamingRules(columns="literal")
    return root


def _field(name: str) -> Any:
    return next(f for f in _root().children()[0].fields() if f.name == name)


def _sqlite_om() -> tuple[ObjectManager, sqlite3.Connection]:
    conn = sqlite3.connect(":memory:")
    conn.execute('CREATE TABLE "holds" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "holdFor" TEXT, "steps" TEXT)')
    return ObjectManager(_root(), SqliteDriver(conn)), conn


def test_an_accepted_iso_duration_is_written_as_a_timedelta() -> None:
    f = _field("holdFor")
    assert _coerce_write_value(f, "P1DT0.5S") == dt.timedelta(days=1, milliseconds=500)
    assert _coerce_write_value(f, "-PT90S") == dt.timedelta(seconds=-90)
    assert _coerce_write_value(f, dt.timedelta(minutes=5)) == dt.timedelta(minutes=5)
    assert _coerce_write_value(_field("steps"), ["PT1M", None]) == [dt.timedelta(minutes=1), None]


@pytest.mark.parametrize("value", ["P1M", "1:30:00", "PT1.5H", "pt1h", 90, 1.5])
def test_a_value_that_is_not_a_duration_is_refused_on_write(value: object) -> None:
    with pytest.raises(ValueError, match="field.duration 'holdFor' cannot be written"):
        _coerce_write_value(_field("holdFor"), value)


def test_postgres_binds_the_native_timedelta() -> None:
    td = dt.timedelta(seconds=-90)
    assert POSTGRES.encode_param(td) is td


@pytest.mark.parametrize("dialect", [SQLITE, MYSQL], ids=lambda d: d.name)
def test_a_text_engine_binds_the_canonical_string(dialect: Any) -> None:
    f = _field("holdFor")
    assert dialect.encode_param(_coerce_write_value(f, "P1DT0.5S")) == "PT24H0.5S"
    assert dialect.encode_param(_coerce_write_value(f, dt.timedelta(seconds=-90))) == "-PT1M30S"


@pytest.mark.parametrize("dialect", [SQLITE, MYSQL], ids=lambda d: d.name)
def test_the_text_binding_is_by_field_not_by_value(dialect: Any) -> None:
    # A timedelta the duration write codec did not make (a caller's value for some other
    # column, an operand on an undeclared one) binds exactly as it did before.
    td = dt.timedelta(minutes=5)
    assert dialect.encode_param(td) is td
    assert isinstance(_coerce_write_value(_field("holdFor"), "PT5M"), DurationParam)


def test_a_duration_past_the_shared_bound_is_refused_on_write_and_read() -> None:
    f = _field("holdFor")
    assert _coerce_write_value(f, "PT256204778H") == dt.timedelta(hours=256_204_778)
    with pytest.raises(ValueError, match="out of range"):
        _coerce_write_value(f, dt.timedelta(hours=256_204_778, microseconds=1))
    with pytest.raises(ValueError, match="cannot be written"):
        _coerce_write_value(f, "PT256204779H")
    with pytest.raises(ValueError, match="out of range"):
        _decode_read_value(f, dt.timedelta(hours=256_204_779))
    with pytest.raises(ValueError, match="out of range"):
        _decode_read_value(f, "256204779:00:00")


def test_every_engine_reads_back_a_timedelta() -> None:
    f = _field("holdFor")
    assert _decode_read_value(f, dt.timedelta(hours=26)) == dt.timedelta(hours=26)  # pg8000
    assert _decode_read_value(f, "-PT1M30S") == dt.timedelta(seconds=-90)  # a TEXT column
    assert _decode_read_value(f, "1 day 02:00:00") == dt.timedelta(hours=26)  # interval text
    assert _decode_read_value(_field("steps"), [dt.timedelta(minutes=1), None]) == [dt.timedelta(minutes=1), None]


def test_an_interval_with_a_month_part_is_refused_on_read() -> None:
    pg8000_types = pytest.importorskip("pg8000.types")
    with pytest.raises(ValueError, match="year or month part"):
        _decode_read_value(_field("holdFor"), pg8000_types.PGInterval(months=1))
    with pytest.raises(ValueError, match="year or month part"):
        _decode_read_value(_field("holdFor"), "1 mon 00:00:01")


def test_sqlite_round_trip_stores_the_canonical_string() -> None:
    om, conn = _sqlite_om()
    created = om.create("Hold", {"holdFor": "P1DT0.5S"})
    assert created["holdFor"] == dt.timedelta(days=1, milliseconds=500)
    assert conn.execute('SELECT "holdFor" FROM "holds"').fetchone() == ("PT24H0.5S",)
    (row,) = om.find_many("Hold", {"holdFor": {"eq": "PT24H0.5S"}})
    assert row["holdFor"] == dt.timedelta(hours=24, milliseconds=500)
    # Equal spans are equal strings, so a filter in another accepted spelling still matches.
    assert len(om.find_many("Hold", {"holdFor": {"in": ["P1DT0.5S", "PT1H"]}})) == 1


# ── a duration inside a jsonb value object ───────────────────────────────────

_VO_META = {
    "metadata.root": {
        "package": "acme::ops",
        "children": [
            {"object.value": {"name": "Inner", "children": [{"field.duration": {"name": "wait"}}]}},
            {
                "object.value": {
                    "name": "Window",
                    "children": [
                        {"field.string": {"name": "label"}},
                        {"field.duration": {"name": "timeout"}},
                        {"field.duration": {"name": "steps", "isArray": True}},
                        {"field.object": {"name": "inner", "@objectRef": "Inner"}},
                    ],
                }
            },
            {
                "object.entity": {
                    "name": "Plan",
                    "children": [
                        {"source.rdb": {"@table": "plans"}},
                        {"field.long": {"name": "id"}},
                        {"field.object": {"name": "settings", "@objectRef": "Window", "@storage": "jsonb"}},
                        {"field.object": {"name": "windows", "@objectRef": "Window", "@storage": "jsonb", "isArray": True}},
                        {"field.map": {"name": "byName", "@objectRef": "Window"}},
                        {"identity.primary": {"name": "pk", "@fields": ["id"], "@generation": "increment"}},
                    ],
                }
            },
        ],
    }
}


def _plan_om() -> tuple[ObjectManager, sqlite3.Connection]:
    result = load_string(json.dumps(_VO_META))
    assert not result.errors, [str(e) for e in result.errors]
    root: Any = result.root
    root.naming = NamingRules(columns="literal")
    conn = sqlite3.connect(":memory:")
    conn.execute(
        'CREATE TABLE "plans" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, '
        '"settings" TEXT, "windows" TEXT, "byName" TEXT)'
    )
    return ObjectManager(root, SqliteDriver(conn)), conn


def _window(timeout: Any, steps: list[Any], wait: Any) -> dict[str, Any]:
    return {"label": "w", "timeout": timeout, "steps": steps, "inner": {"wait": wait}}


def test_a_value_object_duration_is_stored_and_read_canonical() -> None:
    om, conn = _plan_om()
    created = om.create("Plan", {
        "settings": _window("PT90M", ["PT5400S", None], "P1D"),
        "windows": [_window(dt.timedelta(seconds=-90), [], "PT0.500S")],
        "byName": {"a": _window("PT1H", ["P1DT2H"], None)},
    })
    stored = dict(zip(("settings", "windows", "byName"), conn.execute(
        'SELECT "settings", "windows", "byName" FROM "plans"'
    ).fetchone()))
    expected = {
        "settings": _window("PT1H30M", ["PT1H30M", None], "PT24H"),
        "windows": [_window("-PT1M30S", [], "PT0.5S")],
        "byName": {"a": _window("PT1H", ["PT26H"], None)},
    }
    assert {k: json.loads(v) for k, v in stored.items()} == expected
    assert {k: created[k] for k in expected} == expected
    (row,) = om.find_many("Plan")
    assert {k: row[k] for k in expected} == expected


def test_a_value_object_duration_stored_non_canonical_reads_back_canonical() -> None:
    om, conn = _plan_om()
    conn.execute(
        'INSERT INTO "plans" ("settings") VALUES (?)',
        (json.dumps({"timeout": "PT90M", "steps": ["P1D"], "inner": {"wait": "PT60S"}}),),
    )
    (row,) = om.find_many("Plan")
    assert row["settings"] == {"timeout": "PT1H30M", "steps": ["PT24H"], "inner": {"wait": "PT1M"}}


def test_a_value_object_member_that_is_not_a_duration_is_refused_on_write() -> None:
    om, _ = _plan_om()
    with pytest.raises(ValueError, match="field.duration 'timeout' cannot be written"):
        om.create("Plan", {"settings": {"timeout": "P1M"}})
    with pytest.raises(ValueError, match="field.duration 'wait' cannot be written"):
        om.create("Plan", {"windows": [{"inner": {"wait": "PT256204779H"}}]})
