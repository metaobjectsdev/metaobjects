"""FR-018 Unit 14 — M:N traversal api-contract conformance, HAND-ROLLED lane.

Drives the shared ``fixtures/api-contract-conformance/m2m/`` scenarios (hetero,
directed self-join, symmetric) over HTTP via FastAPI ``TestClient`` against the
hand-rolled reference server (``api_contract_m2m_server.py``), one Postgres
testcontainer per scenario. Mirrors the TS
``api-contract-m2m.test.ts`` hand-rolled lane.

Run on-demand (Docker must be available):

    cd server/python
    uv run --extra dev pytest tests/integration/test_api_contract_m2m.py -v
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient

from . import api_contract_assertions
from .api_contract_m2m_server import M2mRepository, make_app
from .postgres_container import PostgresContainer


def _find_m2m_dir(start: Path | None = None) -> Path:
    cur = (start or Path.cwd()).resolve()
    while cur != cur.parent:
        candidate = cur / "fixtures" / "api-contract-conformance" / "m2m"
        if candidate.is_dir():
            return candidate
        cur = cur.parent
    raise RuntimeError(
        f"Could not find fixtures/api-contract-conformance/m2m from {Path.cwd().resolve()}"
    )


_M2M_DIR = _find_m2m_dir()
_SEED: dict[str, list[dict[str, Any]]] = json.loads((_M2M_DIR / "seed.json").read_text())


def _load_scenarios() -> list[tuple[str, dict[str, Any]]]:
    out: list[tuple[str, dict[str, Any]]] = []
    for path in sorted((_M2M_DIR / "scenarios").glob("*.yaml")):
        raw = yaml.safe_load(path.read_text())
        out.append((raw["name"], raw))
    return out


_SCENARIOS = _load_scenarios()


@pytest.mark.parametrize(
    "scenario_name,scenario",
    _SCENARIOS,
    ids=[name for name, _ in _SCENARIOS],
)
def test_api_contract_m2m_scenario(scenario_name: str, scenario: dict[str, Any]) -> None:
    with PostgresContainer() as pg:
        repo = M2mRepository(pg.info())
        repo.create_schema()
        repo.apply_seed(_SEED)
        client = TestClient(make_app(repo))
        for req in scenario.get("requests", []):
            _run_request(client, scenario_name, req)


def _run_request(client: TestClient, scenario_name: str, req: dict[str, Any]) -> None:
    method = str(req["method"]).upper()
    path = str(req["path"])
    expect = req["expect"]
    response = client.request(method, path)
    parsed = _parse_response_body(response.text)
    api_contract_assertions.assert_response(
        scenario_name=scenario_name,
        request_id=str(req.get("id", "?")),
        expect_status=int(expect["status"]),
        expect_body=expect.get("body"),
        status=response.status_code,
        body=parsed,
    )


def _parse_response_body(text: str | None) -> Any:
    if text is None or text == "":
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text
