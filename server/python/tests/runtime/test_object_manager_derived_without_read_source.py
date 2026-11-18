"""An entity may carry a derived (``origin.*``) field that only a projection reads, with no read
view of its own: the shared fixture ``entity-derived-filter-gate`` (``Member.hasActiveAgreement``,
an ``origin.first`` a projection's ``@filter`` reaches). Its table, the one ``meta migrate``
creates, has no column for that field, so the ObjectManager reads the table without it. Before,
the SELECT named ``has_active_agreement`` and the read failed on every engine.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

from metaobjects import load_directory
from metaobjects.runtime import ObjectManager, SqliteDriver

_FIXTURE = Path(__file__).resolve().parents[4] / "fixtures" / "conformance" / "entity-derived-filter-gate" / "input"


def _om() -> ObjectManager:
    result = load_directory(_FIXTURE)
    assert [e.code for e in result.errors] == []
    conn = sqlite3.connect(":memory:")
    conn.execute('CREATE TABLE "members" ("id" INTEGER PRIMARY KEY NOT NULL)')
    conn.execute('INSERT INTO "members" ("id") VALUES (7)')
    return ObjectManager(result.root, SqliteDriver(conn))


def test_a_list_read_selects_no_column_for_the_derived_field() -> None:
    assert _om().find_many("Member") == [{"id": 7}]


def test_a_by_id_read_selects_no_column_for_the_derived_field() -> None:
    assert _om().find_by_id("Member", 7) == {"id": 7}
