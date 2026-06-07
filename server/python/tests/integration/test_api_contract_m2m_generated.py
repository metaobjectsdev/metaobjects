"""FR-018 Unit 14 — M:N traversal api-contract conformance, GENERATED lane.

Runs the REAL ``router_generator`` output for the M:N source entities (Post,
Person) over HTTP via FastAPI ``TestClient``, with the generated
``find_related_<relation>`` consumer seam filled by an in-memory join
(``generated_m2m_app.build_generated_m2m_app``). Drives the same shared
``fixtures/api-contract-conformance/m2m/`` scenarios + the same
``expect.body.*`` vocabulary as the hand-rolled reference lane
(``test_api_contract_m2m.py``).

No Testcontainers — the generated router is the artifact; its join seam is filled
in-memory (real DB join behavior is owned by persistence-conformance). Mirrors
the single-entity GENERATED lane (``test_api_contract_generated.py``) and the TS
``api-contract-m2m.test.ts`` GENERATED lane.

Run on-demand:

    cd server/python
    uv run --extra dev pytest tests/integration/test_api_contract_m2m_generated.py -v
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient

from . import api_contract_assertions
from .generated_m2m_app import build_generated_m2m_app


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
_APP, _REPO = build_generated_m2m_app(_M2M_DIR)
_CLIENT = TestClient(_APP)


@pytest.mark.parametrize(
    "scenario_name,scenario",
    _SCENARIOS,
    ids=[name for name, _ in _SCENARIOS],
)
def test_api_contract_m2m_generated_scenario(scenario_name: str, scenario: dict[str, Any]) -> None:
    _REPO.reset()
    _REPO.seed(_SEED)
    for req in scenario.get("requests", []):
        _run_request(scenario_name, req)


def _run_request(scenario_name: str, req: dict[str, Any]) -> None:
    method = str(req["method"]).upper()
    path = str(req["path"])
    expect = req["expect"]
    response = _CLIENT.request(method, path)
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
