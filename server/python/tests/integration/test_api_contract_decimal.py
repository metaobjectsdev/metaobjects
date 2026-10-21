"""ADR-0019 Amendment 1 -- cross-port API contract for ``field.decimal`` (W1 to W4).

Drives ``fixtures/api-contract-conformance/decimal/`` against the GENERATED routers (the
writable ``Entry`` router and the served ``EntryTotals`` report router) on a REAL database:
the corpus' TypeScript-produced ``schema.<engine>.sql`` runs verbatim on Postgres, SQLite and
MySQL 8.4, ``entries`` is seeded from ``seed.json`` (amounts are strings, never numbers), and
each generated consumer seam is an ``ObjectManager`` repository. A scenario's top-level
``engines:`` is EXACT (an unknown name is an error); without it a scenario runs on every
engine the lane has.

Beyond the scenario's own assertions every response is held to the typed decimal gate: a field
the model declares decimal must be ``null`` or a canonical string, never a JSON number.
"""
from __future__ import annotations

import json
import re
from collections.abc import Iterator
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient

from . import api_contract_assertions
from .generated_report_app import LaneModel, build_generated_report_app
from .mysql_container import MySqlInfo
from .report_lane import ENGINES, ReportLane, open_lane

_CORPUS = next(
    p / "fixtures" / "api-contract-conformance" / "decimal"
    for p in [Path(__file__).resolve(), *Path(__file__).resolve().parents]
    if (p / "fixtures" / "api-contract-conformance" / "decimal").is_dir()
)
_MODEL = LaneModel(reports=(("EntryTotals", "entry_totals"),), entities=(("Entry", "entry"),))
_KNOWN_ENGINES = {"postgres", "mysql", "sqlite", "d1"}
#: The fields the model declares decimal: Entry.amount and the EntryTotals measures that
#: sum, average, take a maximum or divide a decimal.
_DECIMAL_FIELDS = ("amount", "total", "totalOrZero", "mean", "top", "flaggedShare", "perFlagged")
_CANONICAL = re.compile(r"^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$")


def _load() -> list[tuple[str, dict[str, Any]]]:
    out = []
    for path in sorted((_CORPUS / "scenarios").glob("*.yaml")):
        raw = yaml.safe_load(path.read_text())
        engines = raw.get("engines")
        if engines is not None:
            if not isinstance(engines, list) or not engines or set(engines) - _KNOWN_ENGINES:
                raise RuntimeError(f"{path.name}: unknown or empty engines: {engines!r}")
        out.append((raw["name"], raw))
    return out


_SCENARIOS = _load()


class _Lane:
    def __init__(self, lane: ReportLane) -> None:
        self.lane = lane
        app, _ = build_generated_report_app(_CORPUS, lane.om, _MODEL)
        self.client = TestClient(app)


@pytest.fixture(scope="module", params=ENGINES)
def lane(request: pytest.FixtureRequest, tmp_path_factory: pytest.TempPathFactory) -> Iterator[_Lane]:
    engine: str = request.param
    mysql: MySqlInfo | None = None
    if engine == "mysql":
        from .mysql_container import reset_database

        mysql = request.getfixturevalue("mysql_server")
        reset_database(mysql)
    with open_lane(
        engine, _CORPUS, sqlite_path=tmp_path_factory.mktemp("decimal") / "decimal.db", mysql=mysql
    ) as opened:
        yield _Lane(opened)


def _check_typed(scenario: str, rid: str, body: Any) -> None:
    rows = body if isinstance(body, list) else [body] if isinstance(body, dict) else []
    for row in rows:
        if not isinstance(row, dict):
            continue
        for name in _DECIMAL_FIELDS:
            if name in row:
                v = row[name]
                assert v is None or (isinstance(v, str) and _CANONICAL.match(v)), (
                    f"{scenario} / {rid}: decimal field {name!r} must be null or a canonical string, got {v!r}"
                )


@pytest.mark.parametrize("name,scenario", _SCENARIOS, ids=[n for n, _ in _SCENARIOS])
def test_decimal_scenario(lane: _Lane, name: str, scenario: dict[str, Any]) -> None:
    engines = scenario.get("engines")
    if engines is not None and lane.lane.engine not in engines:
        pytest.skip(f"{name} does not run on {lane.lane.engine}")
    lane.lane.reseed(empty=bool((scenario.get("setup") or {}).get("truncate")))
    for req in scenario.get("requests", []):
        kwargs: dict[str, Any] = {}
        if req.get("body") is not None:
            kwargs["content"] = json.dumps(req["body"])
            kwargs["headers"] = {"content-type": "application/json"}
        response = lane.client.request(str(req["method"]).upper(), str(req["path"]), **kwargs)
        text = response.text
        parsed = api_contract_assertions.parse_body(text) if text else None
        rid = str(req.get("id", "?"))
        expect = req["expect"]
        _check_typed(name, rid, parsed)
        api_contract_assertions.assert_response(
            scenario_name=name,
            request_id=rid,
            expect_status=int(expect["status"]),
            expect_body=expect.get("body"),
            status=response.status_code,
            body=parsed,
        )


@pytest.mark.parametrize("engine", ["postgres", "mysql"])
def test_the_views_return_the_expected_reports(lane: _Lane, engine: str) -> None:
    """On the exact engines the real view returns ``seed.json`` ``reports``, compared by value."""
    if lane.lane.engine != engine:
        pytest.skip("other engine")
    lane.lane.reseed(empty=False)
    actual = {r["bucket"]: r for r in lane.lane.om.find_many("EntryTotals")}
    for want in lane.lane.expected_reports["EntryTotals"]:
        got = actual[want["bucket"]]
        for k, v in want.items():
            if k == "bucket":
                assert got[k] == v
            elif isinstance(v, str):
                assert Decimal(str(got[k])) == Decimal(v), (want["bucket"], k, got[k], v)
            elif v is None:
                assert got[k] is None, (want["bucket"], k)
            else:
                assert got[k] == v, (want["bucket"], k)
