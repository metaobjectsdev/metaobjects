"""Issue #203 — ObjectManager honors ``field.timestamp @autoSet: onCreate|onUpdate``.

The runtime write path (``create`` / ``update`` / ``insert_preserving``) owns
the ``now()`` stamping so adopters stop hand-writing it in every repository. The
contract (identical across ports):

* ``create``  — stamps EVERY ``onCreate`` AND ``onUpdate`` column with a single
  shared ``now()`` (the caller's value is ignored; a fresh row's updated ==
  created).
* ``update``  — stamps ``onUpdate`` with ``now()`` and NEVER writes an
  ``onCreate`` column (stripped even when the caller supplies one — the
  lost-update guard).
* ``insert_preserving`` — the escape hatch: writes the ``@autoSet`` columns
  VERBATIM (import / restore / replication paths that must keep the original
  timestamps).
* ``now()`` is keyed off the COLUMN's temporal type (``field.timestamp`` →
  datetime, tz-aware unless ``@localTime``; ``field.date`` → date).

White-box: a fake driver captures the emitted INSERT/UPDATE SQL + bound params
so the stamping is asserted without a database.
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime
from typing import Any

from metaobjects import load_string
from metaobjects.runtime import ObjectManager
from metaobjects.runtime.object_manager import SelectResult

# BaseAudit carries the @autoSet timestamps; Doc INHERITS them via extends — the
# issue's exact real-world shape (declared once on a base, inherited everywhere).
# Plain has no @autoSet (proves byte-identical behavior for non-@autoSet entities).
# DateDoc exercises a non-timestamp temporal (field.date) @autoSet column.
_META = {
    "metadata.root": {
        "package": "t",
        "children": [
            {
                "object.entity": {
                    "name": "BaseAudit",
                    "abstract": True,
                    "children": [
                        {"field.timestamp": {"name": "createdAt", "@autoSet": "onCreate"}},
                        {"field.timestamp": {"name": "updatedAt", "@autoSet": "onUpdate"}},
                    ],
                }
            },
            {
                "object.entity": {
                    "name": "Doc",
                    "extends": "BaseAudit",
                    "children": [
                        {"source.rdb": {"@table": "docs"}},
                        {"field.long": {"name": "id"}},
                        {"field.string": {"name": "title", "@required": True}},
                        # @localTime opt-out → naive wall-clock stamp (no tzinfo).
                        {"field.timestamp": {"name": "touchedAt", "@autoSet": "onUpdate", "@localTime": True}},
                        {"identity.primary": {"name": "id", "@fields": ["id"]}},
                    ],
                }
            },
            {
                "object.entity": {
                    "name": "Plain",
                    "children": [
                        {"source.rdb": {"@table": "plains"}},
                        {"field.long": {"name": "id"}},
                        {"field.string": {"name": "name"}},
                        {"identity.primary": {"name": "id", "@fields": ["id"]}},
                    ],
                }
            },
            {
                "object.entity": {
                    "name": "DateDoc",
                    "children": [
                        {"source.rdb": {"@table": "datedocs"}},
                        {"field.long": {"name": "id"}},
                        {"field.date": {"name": "createdOn", "@autoSet": "onCreate"}},
                        {"identity.primary": {"name": "id", "@fields": ["id"]}},
                    ],
                }
            },
        ],
    }
}


class FakeWriteDriver:
    """Captures the write SQL + params; returns a canned single-row result so the
    ObjectManager's RETURNING-row mapping does not crash."""

    def __init__(self) -> None:
        self.inserts: list[tuple[str, tuple[Any, ...]]] = []
        self.updates: list[tuple[str, tuple[Any, ...]]] = []

    def insert_returning(self, sql: str, params: tuple[Any, ...] = ()) -> SelectResult:
        self.inserts.append((sql, params))
        return SelectResult([{"id": 1}], {})

    def update_returning(self, sql: str, params: tuple[Any, ...] = ()) -> SelectResult:
        self.updates.append((sql, params))
        return SelectResult([{"id": 1}], {})

    def select(self, sql: str, params: tuple[Any, ...] = ()) -> SelectResult:  # pragma: no cover
        return SelectResult([{"id": 1}], {})

    def scalar(self, sql: str, params: tuple[Any, ...] = ()) -> Any:  # pragma: no cover
        return None

    def execute_rowcount(self, sql: str, params: tuple[Any, ...] = ()) -> int:  # pragma: no cover
        return 1


def _om() -> tuple[ObjectManager, FakeWriteDriver]:
    root = load_string(json.dumps(_META)).root
    driver = FakeWriteDriver()
    return ObjectManager(root, driver), driver  # type: ignore[arg-type]


def _insert_cols(sql: str, params: tuple[Any, ...]) -> dict[str, Any]:
    """Map INSERT column → bound param."""
    m = re.search(r'INSERT INTO "[^"]+" \(([^)]*)\) VALUES', sql)
    assert m is not None, sql
    cols = [c.strip().strip('"') for c in m.group(1).split(",")]
    return dict(zip(cols, params))


def _update_set(sql: str, params: tuple[Any, ...]) -> dict[str, Any]:
    """Map UPDATE SET column → bound param (WHERE/pk params excluded)."""
    m = re.search(r"\bSET (.*?) WHERE ", sql)
    assert m is not None, sql
    cols = re.findall(r'"([^"]+)" = %s', m.group(1))
    return dict(zip(cols, params[: len(cols)]))


# --- create -----------------------------------------------------------------


def test_create_stamps_both_oncreate_and_onupdate_equal() -> None:
    om, d = _om()
    om.create("Doc", {"title": "hello"})
    cols = _insert_cols(*d.inserts[0])
    assert isinstance(cols["createdAt"], datetime)
    assert isinstance(cols["updatedAt"], datetime)
    # A fresh row's updated timestamp equals its created one (single shared now()).
    assert cols["createdAt"] == cols["updatedAt"]


def test_create_ignores_caller_supplied_autoset_values() -> None:
    om, d = _om()
    om.create("Doc", {"title": "x", "createdAt": "2000-01-01T00:00:00Z", "updatedAt": "2000-01-01T00:00:00Z"})
    cols = _insert_cols(*d.inserts[0])
    # The stale caller value is overridden with a fresh now(), not persisted.
    assert cols["createdAt"].year != 2000
    assert cols["createdAt"] == cols["updatedAt"]


def test_create_localtime_is_naive_default_is_tzaware() -> None:
    om, d = _om()
    om.create("Doc", {"title": "x"})
    cols = _insert_cols(*d.inserts[0])
    # Default field.timestamp is instant / tz-aware; @localTime opts into naive.
    assert cols["createdAt"].tzinfo is not None
    assert cols["touchedAt"].tzinfo is None


def test_create_date_autoset_stamped_as_date() -> None:
    om, d = _om()
    om.create("DateDoc", {})
    cols = _insert_cols(*d.inserts[0])
    # field.date now() is a date, not a datetime (keyed off the column's type).
    assert isinstance(cols["createdOn"], date)
    assert not isinstance(cols["createdOn"], datetime)


# --- update -----------------------------------------------------------------


def test_update_bumps_onupdate_and_skips_oncreate() -> None:
    om, d = _om()
    om.update("Doc", 1, {"title": "new"})
    setmap = _update_set(*d.updates[0])
    assert isinstance(setmap["updatedAt"], datetime)
    assert isinstance(setmap["touchedAt"], datetime)
    # created_at is write-once: never in the UPDATE SET clause.
    assert "createdAt" not in setmap


def test_update_strips_caller_supplied_createdAt() -> None:
    om, d = _om()
    # A full-row update carrying a stale createdAt must NOT rewrite it (lost-update guard).
    om.update("Doc", 1, {"title": "new", "createdAt": "2000-01-01T00:00:00Z"})
    setmap = _update_set(*d.updates[0])
    assert "createdAt" not in setmap


def test_update_overrides_caller_supplied_updatedAt() -> None:
    om, d = _om()
    om.update("Doc", 1, {"updatedAt": "2000-01-01T00:00:00Z"})
    setmap = _update_set(*d.updates[0])
    assert isinstance(setmap["updatedAt"], datetime)
    # Server owns updated_at — the caller's stale value is replaced with now().
    assert setmap["updatedAt"].year != 2000


# --- insert_preserving (escape hatch) ---------------------------------------


def test_insert_preserving_writes_autoset_verbatim() -> None:
    om, d = _om()
    om.insert_preserving(
        "Doc",
        {"title": "x", "createdAt": "2000-01-01T00:00:00Z", "updatedAt": "2001-02-03T04:05:06Z"},
    )
    cols = _insert_cols(*d.inserts[0])
    # Verbatim: the caller's original instants are preserved (no now() stamping).
    assert cols["createdAt"].year == 2000
    assert cols["updatedAt"].year == 2001


# --- non-@autoSet entity: byte-identical (no behavior change) ---------------


def test_entity_without_autoset_is_unchanged_on_create() -> None:
    om, d = _om()
    om.create("Plain", {"id": 5, "name": "n"})
    cols = _insert_cols(*d.inserts[0])
    assert set(cols.keys()) == {"id", "name"}


def test_entity_without_autoset_is_unchanged_on_update() -> None:
    om, d = _om()
    om.update("Plain", 5, {"name": "n2"})
    setmap = _update_set(*d.updates[0])
    assert set(setmap.keys()) == {"name"}
