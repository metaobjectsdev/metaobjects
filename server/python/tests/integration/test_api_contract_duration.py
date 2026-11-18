"""Cross-port API contract for ``field.duration`` (D1 to D4).

Drives ``fixtures/api-contract-conformance/duration/`` against the GENERATED ``Timer`` router
on a REAL database: the corpus' ``schema.<engine>.sql`` runs verbatim on Postgres, SQLite and
MySQL 8.4, ``timers`` is seeded from ``seed.json`` (empty, so the first POST is id 1), and the
generated consumer seam is an ``ObjectManager`` repository. The corpus config pins
``wire.durations: iso``. A scenario's top-level ``engines:`` is EXACT; without it a scenario
runs on every engine the lane has. Same harness as ``test_api_contract_decimal.py``.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
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
    p / "fixtures" / "api-contract-conformance" / "duration"
    for p in [Path(__file__).resolve(), *Path(__file__).resolve().parents]
    if (p / "fixtures" / "api-contract-conformance" / "duration").is_dir()
)
_MODEL = LaneModel(reports=(), entities=(("Timer", "timer"),))
_KNOWN_ENGINES = {"postgres", "mysql", "sqlite", "d1"}


def _load() -> list[tuple[str, dict[str, Any]]]:
    out = []
    for path in sorted((_CORPUS / "scenarios").glob("*.yaml")):
        raw = yaml.safe_load(path.read_text())
        engines = raw.get("engines")
        if engines is not None and (not isinstance(engines, list) or not engines or set(engines) - _KNOWN_ENGINES):
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
        engine, _CORPUS, sqlite_path=tmp_path_factory.mktemp("duration") / "duration.db", mysql=mysql
    ) as opened:
        yield _Lane(opened)


@pytest.mark.parametrize("name,scenario", _SCENARIOS, ids=[n for n, _ in _SCENARIOS])
def test_duration_scenario(lane: _Lane, name: str, scenario: dict[str, Any]) -> None:
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
        expect = req["expect"]
        api_contract_assertions.assert_response(
            scenario_name=name,
            request_id=str(req.get("id", "?")),
            expect_status=int(expect["status"]),
            expect_body=expect.get("body"),
            status=response.status_code,
            body=parsed,
        )
