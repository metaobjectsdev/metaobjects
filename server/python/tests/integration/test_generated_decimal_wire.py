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
from metaobjects.codegen.runtime.m2m_codegen import build_object_index
from metaobjects.runtime import ObjectManager, SqliteDriver
from metaobjects.wire import WireFormat

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


#: The portable form the cross-port corpora pin; the canonical-output tests below run in it.
_PORTABLE = WireFormat(decimals="string", null_members="omit")


@pytest.fixture()
def client() -> TestClient:
    return _make_client(_PORTABLE)


def _make_client(wire: WireFormat) -> TestClient:
    root = load_string(json.dumps(_META)).root
    root.wire = wire  # type: ignore[attr-defined]
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


_FLOAT_META = {
    "metadata.root": {
        "package": "acme::fleet",
        "children": [
            {"object.value": {"name": "Fix", "children": [
                {"field.double": {"name": "latitude", "@required": True}},
                {"field.double": {"name": "readings", "isArray": True}},
                {"field.decimal": {"name": "amount", "@precision": 12, "@scale": 4}},
            ]}},
            {"object.value": {"name": "Tier", "children": [
                {"field.decimal": {"name": "amount", "@precision": 12, "@scale": 4}},
            ]}},
            {"object.value": {"name": "Pricing", "children": [
                {"field.map": {"name": "tiers", "@objectRef": "Tier"}},
            ]}},
            {"object.entity": {"name": "Sample", "children": [
                {"source.rdb": {"@table": "samples"}},
                {"field.long": {"name": "id"}},
                {"field.double": {"name": "score"}},
                {"field.decimal": {"name": "series", "isArray": True, "@precision": 9, "@scale": 4}},
                {"field.object": {"name": "fix", "@objectRef": "Fix", "@storage": "jsonb"}},
                {"field.object": {"name": "fixes", "@objectRef": "Fix", "@storage": "jsonb", "isArray": True}},
                {"field.map": {"name": "tiers", "@objectRef": "Tier"}},
                {"field.object": {"name": "pricing", "@objectRef": "Pricing", "@storage": "jsonb"}},
                {"identity.primary": {"name": "pk", "@fields": ["id"], "@generation": "increment"}},
            ]}},
        ],
    }
}


@pytest.fixture()
def float_client() -> TestClient:
    # Canonical decimals; a null member stays as stored (`native`), which this test sends.
    return _make_float_client(WireFormat(decimals="string"))


def _make_float_client(wire: WireFormat) -> TestClient:
    root = load_string(json.dumps(_FLOAT_META)).root
    root.wire = wire  # type: ignore[attr-defined]
    objs = {c.name.split("::")[-1]: c for c in root.children()}
    pkg = f"genflt_{uuid.uuid4().hex[:8]}"
    tmp = Path(tempfile.mkdtemp(prefix="genflt-"))
    pkg_dir = tmp / pkg
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    for vo in ("Fix", "Tier", "Pricing"):
        (pkg_dir / f"{vo}.py").write_text(render_entity_model(objs[vo]))
    sample = objs["Sample"]
    (pkg_dir / "sample_filter_allowlist.py").write_text(render_filter_allowlist(sample) or "")
    (pkg_dir / "Sample.py").write_text(render_entity_model(sample))
    (pkg_dir / "sample_router.py").write_text(render_router(sample) or "")
    sys.path.insert(0, str(tmp))
    try:
        mod = importlib.import_module(f"{pkg}.sample_router")
    finally:
        sys.path.remove(str(tmp))
    db = sqlite3.connect(":memory:", check_same_thread=False)
    db.execute("CREATE TABLE samples (id INTEGER PRIMARY KEY AUTOINCREMENT, score REAL, series TEXT, fix TEXT, fixes TEXT, tiers TEXT, pricing TEXT)")
    om = ObjectManager(root, SqliteDriver(db))  # type: ignore[arg-type]

    class Repo(_Repo):
        def list(self, limit: int, offset: int, sort: Any, filters: list[FilterPredicate]) -> list[Any]:
            return self.om.find_many("Sample", None, sort=[("id", "asc")], limit=limit, offset=offset)

        def find_by_id(self, id: int) -> Any:
            return self.om.find_by_id("Sample", id)

        def create(self, dto: Any) -> Any:
            return self.om.create("Sample", dto)

        def update(self, id: int, dto: Any) -> Any:
            return self.om.update("Sample", id, dto)

    app = FastAPI()
    app.include_router(mod.router)
    app.dependency_overrides[mod.get_repository] = lambda: Repo(om)
    return TestClient(app)


def test_a_double_and_a_jsonb_value_object_take_fractional_numbers_on_every_write(float_client: TestClient) -> None:
    # parse_json_object reads every fractional number as a Decimal; only a declared decimal
    # keeps it. A double, or a number inside a jsonb value object / array, is a float again --
    # json.dumps of the jsonb column used to fail with a 500.
    body = '{"score": 1.5, "fix": {"latitude": 51.25, "readings": [0.5, 2]}, "fixes": [{"latitude": 1.75}]}'
    hdr = {"content-type": "application/json"}
    created = float_client.post("/api/samples", content=body, headers=hdr)
    assert created.status_code == 201, created.text
    assert created.json()["score"] == 1.5
    assert created.json()["fix"]["latitude"] == 51.25
    for send in (float_client.patch, float_client.put):
        resp = send("/api/samples/1", content='{"score": 2.5, "fix": {"latitude": 3.125}}', headers=hdr)
        assert resp.status_code == 200, resp.text
        assert resp.json()["score"] == 2.5 and resp.json()["fix"]["latitude"] == 3.125


def test_a_decimal_inside_a_jsonb_value_object_follows_the_top_level_rule(float_client: TestClient) -> None:
    # C1: a string or a JSON number in, read exactly, stored and emitted as the canonical string.
    hdr = {"content-type": "application/json"}
    ok = float_client.post(
        "/api/samples",
        content='{"fix": {"latitude": 1.5, "amount": "100.5000"}, "fixes": [{"latitude": 2.5, "amount": 2.50}, {"latitude": 3, "amount": null}]}',
        headers=hdr,
    )
    assert ok.status_code == 201, ok.text
    body = ok.json()
    assert body["fix"] == {"latitude": 1.5, "amount": "100.5"}
    assert [f["amount"] for f in body["fixes"]] == ["2.5", None]
    assert float_client.get("/api/samples/1").json()["fix"]["amount"] == "100.5"
    for bad in ('"0.12345"', '"abc"', '"123456789.5"'):
        resp = float_client.post("/api/samples", content='{"fix": {"latitude": 1, "amount": ' + bad + "}}", headers=hdr)
        assert resp.status_code == 400 and resp.json() == {"error": "validation"}, (bad, resp.text)
    assert len(float_client.get("/api/samples").json()) == 1


def test_a_decimal_in_a_value_object_map_applies_to_each_value_and_keys_are_never_members(float_client: TestClient) -> None:
    # C1: a field.map of a value object applies the nested rule to EACH map value; a key named
    # like a member ("amount") is just a key. Top-level map and a map nested in a value object.
    hdr = {"content-type": "application/json"}
    ok = float_client.post(
        "/api/samples",
        content='{"tiers": {"amount": {"amount": "1.5000"}, "gold": {"amount": 2.50}},'
        ' "pricing": {"tiers": {"amount": {"amount": 100}, "silver": {"amount": "0.25"}}}}',
        headers=hdr,
    )
    assert ok.status_code == 201, ok.text
    expected_tiers = {"amount": {"amount": "1.5"}, "gold": {"amount": "2.5"}}
    expected_pricing = {"tiers": {"amount": {"amount": "100"}, "silver": {"amount": "0.25"}}}
    body = ok.json()
    assert body["tiers"] == expected_tiers and body["pricing"] == expected_pricing
    got = float_client.get("/api/samples/1").json()
    assert got["tiers"] == expected_tiers and got["pricing"] == expected_pricing
    for bad in (
        '{"tiers": {"gold": {"amount": "0.12345"}}}',
        '{"pricing": {"tiers": {"amount": {"amount": "0.12345"}}}}',
        '{"tiers": {"amount": {"amount": "abc"}}}',
    ):
        resp = float_client.post("/api/samples", content=bad, headers=hdr)
        assert resp.status_code == 400 and resp.json() == {"error": "validation"}, (bad, resp.text)
    assert len(float_client.get("/api/samples").json()) == 1


def test_a_decimal_array_is_range_checked_element_wise_and_coerced_for_the_driver(float_client: TestClient) -> None:
    # SQLite has no array column, so the write itself is covered on Postgres by the shared
    # api-contract decimal corpus; here: the route refuses an excess-scale element (nothing
    # persisted) and the runtime codec turns a list into a list of Decimals (it used to
    # Decimal(str(list)) and raise InvalidOperation -> 500).
    hdr = {"content-type": "application/json"}
    bad = float_client.post("/api/samples", content='{"series": ["1", "0.12345"]}', headers=hdr)
    assert bad.status_code == 400 and bad.json() == {"error": "validation"}
    root = load_string(json.dumps(_FLOAT_META)).root
    sample = next(c for c in root.children() if c.name.endswith("Sample"))
    series = next(f for f in sample.fields() if f.name == "series")
    from metaobjects.runtime.object_manager import _coerce_write_value

    assert _coerce_write_value(series, [Decimal("1.5"), "2", 3, None]) == [Decimal("1.5"), Decimal("2"), Decimal("3"), None]


# --- the `wire` setting (ADR-0019 Amendment 2): the DEFAULT is native -------------------------


def _row_client(wire: WireFormat, rows: list[dict[str, Any]]) -> TestClient:
    """The Sample router over a repository that returns *rows* verbatim (a driver that keeps a
    decimal's scale, as Postgres and MySQL do; SQLite cannot), under the given wire setting."""
    root = load_string(json.dumps(_FLOAT_META)).root
    root.wire = wire  # type: ignore[attr-defined]
    objs = {c.name.split("::")[-1]: c for c in root.children()}
    pkg = f"genwire_{uuid.uuid4().hex[:8]}"
    tmp = Path(tempfile.mkdtemp(prefix="genwire-"))
    pkg_dir = tmp / pkg
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    for vo in ("Fix", "Tier", "Pricing"):
        (pkg_dir / f"{vo}.py").write_text(render_entity_model(objs[vo]))
    sample = objs["Sample"]
    (pkg_dir / "sample_filter_allowlist.py").write_text(render_filter_allowlist(sample) or "")
    (pkg_dir / "Sample.py").write_text(render_entity_model(sample))
    (pkg_dir / "sample_router.py").write_text(render_router(sample) or "")
    sys.path.insert(0, str(tmp))
    try:
        mod = importlib.import_module(f"{pkg}.sample_router")
    finally:
        sys.path.remove(str(tmp))

    class Repo:
        def list(self, limit: int, offset: int, sort: Any, filters: list[FilterPredicate]) -> list[Any]:
            return rows

        def count(self, filters: list[FilterPredicate]) -> int:
            return len(rows)

        def find_by_id(self, id: int) -> Any:
            return rows[0]

        def create(self, dto: Any) -> Any:
            return rows[0]

    app = FastAPI()
    app.include_router(mod.router)
    app.dependency_overrides[mod.get_repository] = lambda: Repo()
    return TestClient(app)


_DECIMAL_ROW = {
    "id": 1,
    "score": 1.5,
    "series": [Decimal("12.50"), Decimal("0.0000001"), Decimal("100")],
    "fix": None,
    "fixes": None,
    "tiers": None,
    "pricing": None,
}


def test_native_is_the_default_and_writes_a_decimal_as_pydantic_does() -> None:
    """`str(Decimal)`: the scale is kept and a small value keeps its exponent; not the float a
    plain-dict row would become under FastAPI's own encoder."""
    default = _row_client(WireFormat(), [_DECIMAL_ROW])
    assert default.get("/api/samples/1").json()["series"] == ["12.50", "1E-7", "100"]
    assert default.get("/api/samples").json()[0]["series"] == ["12.50", "1E-7", "100"]
    assert default.get("/api/samples?withCount=1").json()["rows"][0]["series"] == ["12.50", "1E-7", "100"]


def test_string_writes_the_canonical_form() -> None:
    string = _row_client(WireFormat(decimals="string"), [_DECIMAL_ROW])
    assert string.get("/api/samples/1").json()["series"] == ["12.5", "0.0000001", "100"]


def test_input_refusals_hold_under_native() -> None:
    native = _row_client(WireFormat(), [_DECIMAL_ROW])
    hdr = {"content-type": "application/json"}
    for bad in ('{"series": ["abc"]}', '{"series": ["0.12345"]}', "[1]", "{"):
        resp = native.post("/api/samples", content=bad, headers=hdr)
        assert resp.status_code == 400 and resp.json() == {"error": "validation"}, (bad, resp.text)
    assert native.post("/api/samples", content='{"series": ["1.5", 2]}', headers=hdr).status_code == 201
    bad_filter = native.get("/api/samples", params={"filter[series][gt]": "oops"})
    assert bad_filter.status_code == 400


#: A stored value object: `latitude` set, `readings` explicitly null, `amount` absent.
_VO_ROW = {**_DECIMAL_ROW, "series": None, "fix": {"latitude": 51.25, "readings": None}}


def test_null_members_native_passes_the_stored_value_object_through() -> None:
    fix = _row_client(WireFormat(), [_VO_ROW]).get("/api/samples/1").json()["fix"]
    assert fix == {"latitude": 51.25, "readings": None}


def test_null_members_omit_drops_a_null_member_but_not_a_null_field() -> None:
    body = _row_client(WireFormat(null_members="omit"), [_VO_ROW]).get("/api/samples/1").json()
    assert body["fix"] == {"latitude": 51.25}
    assert body["tiers"] is None and "tiers" in body  # a top-level field is untouched


def test_null_members_emit_writes_every_declared_member() -> None:
    body = _row_client(WireFormat(null_members="emit"), [_VO_ROW]).get("/api/samples/1").json()
    assert body["fix"] == {"latitude": 51.25, "readings": None, "amount": None}


def test_null_members_reach_arrays_maps_and_nested_value_objects() -> None:
    row = {
        **_DECIMAL_ROW,
        "series": None,
        "fixes": [{"latitude": 1.0}, {"latitude": 2.0, "amount": None}],
        "tiers": {"gold": {"amount": None}},
        "pricing": {"tiers": {"silver": {}}},
    }
    emit = _row_client(WireFormat(null_members="emit"), [row]).get("/api/samples/1").json()
    assert emit["fixes"] == [
        {"latitude": 1.0, "readings": None, "amount": None},
        {"latitude": 2.0, "readings": None, "amount": None},
    ]
    assert emit["tiers"] == {"gold": {"amount": None}}
    assert emit["pricing"] == {"tiers": {"silver": {"amount": None}}}
    omit = _row_client(WireFormat(null_members="omit"), [row]).get("/api/samples/1").json()
    assert omit["fixes"] == [{"latitude": 1.0}, {"latitude": 2.0}]
    assert omit["tiers"] == {"gold": {}}
    assert omit["pricing"] == {"tiers": {"silver": {}}}


def test_a_generated_router_carries_the_setting_only_as_data() -> None:
    root = load_string(json.dumps(_FLOAT_META)).root
    sample = next(c for c in root.children() if c.name.endswith("Sample"))
    assert '_WIRE = WireOutput(decimals="native", null_members="native")' in (render_router(sample) or "")
    root.wire = _PORTABLE  # type: ignore[attr-defined]
    src = render_router(sample) or ""
    assert '_WIRE = WireOutput(decimals="string", null_members="omit", shapes=' in src


# --- an M:N traversal writes the TARGET's rows, so the TARGET's value objects are shaped ----

#: Post and Tag both declare a value object named `meta`, with different members; only Tag has `info`.
_M2M_META = {
    "metadata.root": {
        "package": "acme::blog",
        "children": [
            {"object.value": {"name": "PostMeta", "children": [
                {"field.string": {"name": "headline"}},
            ]}},
            {"object.value": {"name": "TagMeta", "children": [
                {"field.string": {"name": "label"}},
                {"field.string": {"name": "note"}},
            ]}},
            {"object.entity": {"name": "Post", "children": [
                {"source.rdb": {"@table": "posts"}},
                {"field.long": {"name": "id"}},
                {"field.object": {"name": "meta", "@objectRef": "PostMeta", "@storage": "jsonb"}},
                {"relationship.association": {"name": "tags", "@cardinality": "many", "@objectRef": "Tag", "@through": "PostTag"}},
                {"identity.primary": {"name": "pk", "@fields": ["id"], "@generation": "increment"}},
            ]}},
            {"object.entity": {"name": "Tag", "children": [
                {"source.rdb": {"@table": "tags"}},
                {"field.long": {"name": "id"}},
                {"field.object": {"name": "meta", "@objectRef": "TagMeta", "@storage": "jsonb"}},
                {"field.object": {"name": "info", "@objectRef": "TagMeta", "@storage": "jsonb"}},
                {"identity.primary": {"name": "pk", "@fields": ["id"], "@generation": "increment"}},
            ]}},
            {"object.entity": {"name": "PostTag", "children": [
                {"source.rdb": {"@table": "post_tags"}},
                {"field.long": {"name": "postId", "@required": True}},
                {"field.long": {"name": "tagId", "@required": True}},
                {"identity.primary": {"name": "pk", "@fields": ["postId", "tagId"]}},
                {"identity.reference": {"name": "fkPost", "@fields": "postId", "@references": "Post"}},
                {"identity.reference": {"name": "fkTag", "@fields": "tagId", "@references": "Tag"}},
            ]}},
        ],
    }
}


def _m2m_client(wire: WireFormat, tags: list[dict[str, Any]]) -> TestClient:
    root = load_string(json.dumps(_M2M_META)).root
    root.wire = wire  # type: ignore[attr-defined]
    objs = {c.name.split("::")[-1]: c for c in root.children()}
    index = build_object_index(list(objs.values()))
    pkg = f"genm2m_{uuid.uuid4().hex[:8]}"
    tmp = Path(tempfile.mkdtemp(prefix="genm2m-"))
    pkg_dir = tmp / pkg
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    for name in ("PostMeta", "TagMeta", "Tag", "Post"):
        (pkg_dir / f"{name}.py").write_text(render_entity_model(objs[name], index))
    post = objs["Post"]
    (pkg_dir / "post_filter_allowlist.py").write_text(render_filter_allowlist(post) or "")
    (pkg_dir / "post_router.py").write_text(render_router(post, index) or "")
    sys.path.insert(0, str(tmp))
    try:
        mod = importlib.import_module(f"{pkg}.post_router")
    finally:
        sys.path.remove(str(tmp))

    class Repo:
        def find_related_tags(self, id: int) -> list[Any]:
            return tags

    app = FastAPI()
    app.include_router(mod.router)
    app.dependency_overrides[mod.get_repository] = lambda: Repo()
    return TestClient(app)


_TAG_ROW = {"id": 7, "meta": {"label": "x", "note": None}, "info": {"label": "y", "note": None}}


def test_an_m2m_traversal_omits_a_null_member_of_the_targets_value_object() -> None:
    body = _m2m_client(WireFormat(null_members="omit"), [_TAG_ROW]).get("/api/posts/1/tags").json()
    assert body == [{"id": 7, "meta": {"label": "x"}, "info": {"label": "y"}}]


def test_an_m2m_traversal_emits_the_targets_members_not_the_sources() -> None:
    row = {"id": 7, "meta": {"label": "x"}, "info": {"note": "n"}}
    body = _m2m_client(WireFormat(null_members="emit"), [row]).get("/api/posts/1/tags").json()
    assert body == [{"id": 7, "meta": {"label": "x", "note": None}, "info": {"label": None, "note": "n"}}]
