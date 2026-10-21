"""The decimal wire rule (ADR-0019 Amendment 1) through a GENERATED router over HTTP.

The router is the real generator's output, mounted unmodified over an ObjectManager on an
in-memory SQLite database, so the three seams are exercised together: the request body (W2),
the filter operand (W2) and the SQLite read (W4) in, and the canonical string (W1) out.
"""
from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
import tempfile
import threading
import uuid
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from metaobjects import load_string
from metaobjects.codegen.generators.entity_model import render_entity_model
from metaobjects.codegen.generators.filter_allowlist_generator import render_filter_allowlist
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.codegen.runtime.filter_parser import FilterPredicate
from metaobjects.runtime import ObjectManager, SqliteDriver

_META = {
    "metadata.root": {
        "package": "acme::shop",
        "children": [
            {"object.entity": {"name": "Entry", "children": [
                {"source.rdb": {"@table": "entries"}},
                {"field.long": {"name": "id"}},
                {"field.decimal": {"name": "amount", "@precision": 30, "@scale": 20, "@required": True, "@filterable": True}},
                {"field.decimal": {"name": "note", "@precision": 12, "@scale": 2, "@filterable": True}},
                {"identity.primary": {"name": "pk", "@fields": ["id"], "@generation": "increment"}},
            ]}}
        ],
    }
}


class _Repo:
    def __init__(self, om: ObjectManager) -> None:
        self.om = om
        self.lock = threading.Lock()

    @staticmethod
    def _filter(predicates: list[FilterPredicate]) -> Any:
        return {"and": [{p.field: {p.op: p.value}} for p in predicates]} if predicates else None

    def list(self, limit: int, offset: int, sort: Any, filters: list[FilterPredicate]) -> list[Any]:
        with self.lock:
            return self.om.find_many("Entry", self._filter(filters), sort=[("id", "asc")], limit=limit, offset=offset)

    def count(self, filters: list[FilterPredicate]) -> int:
        with self.lock:
            return self.om.count("Entry", self._filter(filters))

    def find_by_id(self, id: int) -> Any:
        with self.lock:
            return self.om.find_by_id("Entry", id)

    def create(self, dto: Any) -> Any:
        with self.lock:
            return self.om.create("Entry", dto)

    def update(self, id: int, dto: Any) -> Any:
        with self.lock:
            return self.om.update("Entry", id, dto)

    def delete(self, id: int) -> bool:
        with self.lock:
            return self.om.delete("Entry", id)


@pytest.fixture()
def client() -> TestClient:
    root = load_string(json.dumps(_META)).root
    entry = next(c for c in root.children() if c.name == "Entry")
    pkg = f"gendec_{uuid.uuid4().hex[:8]}"
    tmp = Path(tempfile.mkdtemp(prefix="gendec-"))
    pkg_dir = tmp / pkg
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    (pkg_dir / "entry_filter_allowlist.py").write_text(render_filter_allowlist(entry) or "")
    (pkg_dir / "Entry.py").write_text(render_entity_model(entry))
    (pkg_dir / "entry_router.py").write_text(render_router(entry) or "")
    sys.path.insert(0, str(tmp))
    try:
        mod = importlib.import_module(f"{pkg}.entry_router")
    finally:
        sys.path.remove(str(tmp))
    db = sqlite3.connect(":memory:", check_same_thread=False)
    db.execute("CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, amount NUMERIC, note NUMERIC)")
    repo = _Repo(ObjectManager(root, SqliteDriver(db)))  # type: ignore[arg-type]
    app = FastAPI()
    app.include_router(mod.router)
    app.dependency_overrides[mod.get_repository] = lambda: repo
    return TestClient(app)


def _post(client: TestClient, body: str) -> Any:
    return client.post("/api/entries", content=body, headers={"content-type": "application/json"})


def test_a_decimal_is_written_in_its_canonical_form(client: TestClient) -> None:
    created = _post(client, '{"amount": "12.50", "note": null}')
    assert created.status_code == 201, created.text
    assert created.text == '{"id":1,"amount":"12.5","note":null}'
    assert client.get("/api/entries/1").json()["amount"] == "12.5"
    assert client.get("/api/entries").json() == [{"id": 1, "amount": "12.5", "note": None}]
    assert client.get("/api/entries?withCount=1").json()["rows"][0]["amount"] == "12.5"


def test_a_json_number_is_accepted_without_a_float_detour(client: TestClient) -> None:
    created = _post(client, '{"amount": 0.1}')
    assert created.status_code == 201, created.text
    assert created.json()["amount"] == "0.1"


def test_put_and_patch_take_decimals_too(client: TestClient) -> None:
    _post(client, '{"amount": "1"}')
    patched = client.patch("/api/entries/1", content='{"amount": "2.250"}', headers={"content-type": "application/json"})
    assert patched.status_code == 200 and patched.json()["amount"] == "2.25"
    bad = client.put("/api/entries/1", content='{"amount": "abc"}', headers={"content-type": "application/json"})
    assert bad.status_code == 400 and bad.json() == {"error": "validation"}


@pytest.mark.parametrize("bad", ['""', '"abc"', '"1,5"', '" 1.5"', '"NaN"', '"Infinity"', '"0x10"', "true", "[1]", '"1e999999999"'])
def test_garbage_is_a_400_validation(client: TestClient, bad: str) -> None:
    resp = _post(client, '{"amount": ' + bad + "}")
    assert resp.status_code == 400, resp.text
    assert resp.json() == {"error": "validation"}


@pytest.mark.parametrize("body", ["{", "", "not json", "[1]", '"text"', "null"])
def test_a_malformed_or_non_object_json_body_is_a_400_validation(client: TestClient, body: str) -> None:
    """Cross-port (Java, Kotlin): the body that is not a JSON object answers 400 validation,
    not the framework's 422."""
    for send in (
        lambda: _post(client, body),
        lambda: client.put("/api/entries/1", content=body, headers={"content-type": "application/json"}),
        lambda: client.patch("/api/entries/1", content=body, headers={"content-type": "application/json"}),
    ):
        resp = send()
        assert resp.status_code == 400, (body, resp.text)
        assert resp.json() == {"error": "validation"}


def test_a_decimal_filter_operand_is_validated_and_exact(client: TestClient) -> None:
    _post(client, '{"amount": "12.5"}')
    _post(client, '{"amount": "100.25"}')
    ok = client.get("/api/entries", params={"filter[amount][gt]": "12.5"})
    assert [r["amount"] for r in ok.json()] == ["100.25"]
    eq = client.get("/api/entries", params={"filter[amount]": "12.50"})
    assert [r["amount"] for r in eq.json()] == ["12.5"]
    for bad in ("abc", "", " 1", "0x10", "NaN"):
        resp = client.get("/api/entries", params={"filter[amount][gt]": bad})
        assert resp.status_code == 400, (bad, resp.text)
        assert resp.json() == {"error": "invalid_filter_value", "field": "amount"}
    resp = client.get("/api/entries", params={"filter[amount][in]": "12.5,oops"})
    assert resp.status_code == 400 and resp.json()["error"] == "invalid_filter_value"
    assert client.get("/api/entries", params={"filter[note][isNull]": "true"}).status_code == 200


def test_the_sqlite_read_is_exact_to_15_significant_digits(client: TestClient) -> None:
    # 0.1 + 0.2 as a double; the stored REAL reads back as the decimal it was meant to be
    created = _post(client, '{"amount": "0.30000000000000004"}')
    assert created.json()["amount"] == "0.3"
    assert client.get("/api/entries/1").json()["amount"] == "0.3"


def test_the_runtime_itself_returns_a_decimal() -> None:
    root = load_string(json.dumps(_META)).root
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, amount NUMERIC, note NUMERIC)")
    om = ObjectManager(root, SqliteDriver(db))  # type: ignore[arg-type]
    row = om.create("Entry", {"amount": Decimal("0.1") + Decimal("0.2")})
    assert row["amount"] == Decimal("0.3") and isinstance(row["amount"], Decimal)


def test_a_value_beyond_the_declared_range_is_a_400_and_nothing_is_rounded(client: TestClient) -> None:
    """W3: @precision 30, @scale 20 here, so 21 fraction digits and 11 integer digits fail."""
    for bad in ('"0.123456789012345678901"', '"12345678901.5"'):
        resp = _post(client, '{"amount": ' + bad + "}")
        assert resp.status_code == 400 and resp.json() == {"error": "validation"}
    assert client.get("/api/entries").json() == []
