"""FR-024 §7 (#214) — ObjectManager read-routing for a write-through entity read-view.

A write-through entity (writable table source + read-only replica view source +
derived ``origin.*`` fields) routes: READS (find_many / find_by_id / count) through
the replica VIEW (which carries the derived columns), WRITES (insert / update) to the
TABLE with the derived columns EXCLUDED from RETURNING, then a re-read through the view
by PK so the returned row carries the derived fields (read-your-writes). Mirrors the TS
reference queries-file. White-box: a fake driver captures the SQL so the routing is
asserted without a database.
"""
from __future__ import annotations

import json
import re
from typing import Any

from metaobjects import load_string
from metaobjects.runtime import ObjectManager
from metaobjects.runtime.object_manager import SelectResult

_META = {
    "metadata.root": {
        "package": "acme::sales",
        "children": [
            {
                "object.entity": {
                    "name": "Customer",
                    "children": [
                        {"source.rdb": {"@table": "customers"}},
                        {"field.long": {"name": "id"}},
                        {"field.string": {"name": "name", "@required": True}},
                        {"identity.primary": {"name": "pk", "@fields": ["id"], "@generation": "increment"}},
                    ],
                }
            },
            {
                "object.entity": {
                    "name": "Order",
                    "children": [
                        {"source.rdb": {"@role": "primary", "@table": "orders"}},
                        {"source.rdb": {"@role": "replica", "@kind": "view", "@view": "v_order_with_customer"}},
                        {"field.long": {"name": "id"}},
                        {"field.long": {"name": "customerId", "@required": True}},
                        {"field.string": {"name": "customerName", "children": [
                            {"origin.passthrough": {"@from": "Customer.name", "@via": "Order.customer"}}]}},
                        {"relationship.association": {"name": "customer", "@objectRef": "Customer", "@cardinality": "one"}},
                        {"identity.primary": {"name": "pk", "@fields": ["id"], "@generation": "increment"}},
                        {"identity.reference": {"name": "ref_customer", "@fields": ["customerId"], "@references": "Customer"}},
                    ],
                }
            },
        ],
    }
}


class FakeDriver:
    """Captures every SQL statement; returns a canned view row (id + customer_name)
    so the read + re-read paths have something to map back."""

    def __init__(self) -> None:
        self.selects: list[str] = []
        self.inserts: list[str] = []
        self.updates: list[str] = []

    def _view_row(self) -> SelectResult:
        # Columns are literal field names (no @column set on the fixture) — the derived
        # view column is "customerName".
        return SelectResult([{"id": 1, "customerId": 5, "customerName": "Acme"}], {})

    def select(self, sql: str, params: tuple[Any, ...] = ()) -> SelectResult:
        self.selects.append(sql)
        return self._view_row()

    def insert_returning(self, sql: str, params: tuple[Any, ...] = ()) -> SelectResult:
        self.inserts.append(sql)
        return SelectResult([{"id": 1}], {})  # table RETURNING (non-derived)

    def update_returning(self, sql: str, params: tuple[Any, ...] = ()) -> SelectResult:
        self.updates.append(sql)
        return SelectResult([{"id": 1}], {})

    def scalar(self, sql: str, params: tuple[Any, ...] = ()) -> Any:  # pragma: no cover
        return None

    def execute_rowcount(self, sql: str, params: tuple[Any, ...] = ()) -> int:  # pragma: no cover
        return 1


def _om() -> tuple[ObjectManager, FakeDriver]:
    root = load_string(json.dumps(_META)).root
    d = FakeDriver()
    return ObjectManager(root, d), d  # type: ignore[arg-type]


def _from(sql: str) -> str:
    m = re.search(r'FROM "([^"]+)"', sql)
    assert m is not None, sql
    return m.group(1)


def _returning_cols(sql: str) -> list[str]:
    m = re.search(r"RETURNING (.*)$", sql)
    assert m is not None, sql
    return re.findall(r'"([^"]+)"', m.group(1))


def test_reads_route_to_the_replica_view_and_select_derived() -> None:
    om, d = _om()
    om.find_many("Order")
    # the read runs against the replica view (not the write table) and selects the
    # derived column (which lives only on the view).
    assert _from(d.selects[-1]) == "v_order_with_customer"
    assert '"customerName"' in d.selects[-1]


def test_vanilla_entity_reads_are_unchanged() -> None:
    om, d = _om()
    om.find_many("Customer")
    # a non-write-through entity still reads its own table — byte-identical behavior.
    assert _from(d.selects[-1]) == "customers"


def test_create_writes_table_excludes_derived_from_returning_and_rereads_view() -> None:
    om, d = _om()
    result = om.create("Order", {"customerId": 5})
    # write targets the TABLE; RETURNING omits the derived column (no such column there).
    assert d.inserts[0].startswith('INSERT INTO "orders"')
    assert "customerName" not in _returning_cols(d.inserts[0])
    # then a re-read through the VIEW by PK (read-your-writes) → the returned row carries
    # the derived field.
    assert _from(d.selects[-1]) == "v_order_with_customer"
    assert result["customerName"] == "Acme"


def test_update_writes_table_excludes_derived_from_returning_and_rereads_view() -> None:
    om, d = _om()
    result = om.update("Order", 1, {"customerId": 6})
    assert d.updates[0].startswith('UPDATE "orders"')
    assert "customerName" not in _returning_cols(d.updates[0])
    assert _from(d.selects[-1]) == "v_order_with_customer"
    assert result["customerName"] == "Acme"


def _set_cols(sql: str) -> list[str]:
    m = re.search(r"\bSET (.*?) WHERE ", sql)
    assert m is not None, sql
    return re.findall(r'"([^"]+)" = %s', m.group(1))


def test_read_modify_write_roundtrip_drops_the_derived_field_from_the_write() -> None:
    # A client GETs the read model (which carries the derived customerName) and PUTs the
    # whole object back. The write path must DROP the derived field — it has no column on
    # the write table — rather than emit `SET "customerName" = %s` (which 500s).
    om, d = _om()
    om.update("Order", 1, {"customerId": 6, "customerName": "Whatever"})
    assert "customerName" not in _set_cols(d.updates[0])
    assert "customerId" in _set_cols(d.updates[0])

    # Same on create: a derived field in the body is not INSERTed into the table.
    om2, d2 = _om()
    om2.create("Order", {"customerId": 5, "customerName": "Whatever"})
    m = re.search(r'INSERT INTO "orders" \(([^)]*)\) VALUES', d2.inserts[0])
    assert m is not None, d2.inserts[0]
    insert_cols = [c.strip().strip('"') for c in m.group(1).split(",")]
    assert "customerName" not in insert_cols
    assert "customerId" in insert_cols
