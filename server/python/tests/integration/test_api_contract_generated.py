"""SP-F Unit 4 — cross-port API contract conformance against the GENERATED router.

The generated-server lane (peer to the TS `api-contract-generated.test.ts`):
runs the REAL `router_generator` output for `Author` over HTTP via FastAPI
`TestClient`, with a minimal in-memory repo behind the generated consumer seam
(see `generated_router_app.py`). Drives the same 20 scenarios + the same
`expect.body.*` vocabulary as the hand-rolled reference lane
(`test_api_contract.py`, which is retained).

No Testcontainers — the generated router is the artifact, and its persistence
seam is filled in-memory. Real DB behavior stays owned by persistence-conformance.

Run on-demand:

    cd server/python
    uv run --extra dev pytest tests/integration/test_api_contract_generated.py -v
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient

from . import api_contract_assertions
from .generated_router_app import build_generated_app


def _find_corpus_root(start: Path | None = None) -> Path:
    cur = (start or Path.cwd()).resolve()
    while cur != cur.parent:
        candidate = cur / "fixtures" / "api-contract-conformance"
        if candidate.is_dir():
            return candidate
        cur = cur.parent
    raise RuntimeError(
        f"Could not find fixtures/api-contract-conformance from {Path.cwd().resolve()}"
    )


_CORPUS = _find_corpus_root()


def _load_scenarios() -> list[tuple[str, dict[str, Any]]]:
    out: list[tuple[str, dict[str, Any]]] = []
    for path in sorted((_CORPUS / "scenarios").glob("*.yaml")):
        raw = yaml.safe_load(path.read_text())
        out.append((raw["name"], raw))
    return out


def _load_seed_rows() -> list[dict[str, Any]]:
    parsed = json.loads((_CORPUS / "seed.json").read_text())
    rows = parsed.get("rows")
    if not isinstance(rows, list):
        raise RuntimeError("seed.json: missing 'rows' array")
    return rows


_SEED_ROWS = _load_seed_rows()
_SCENARIOS = _load_scenarios()

# Build the generated app + repo once; reset/seed the in-memory repo per scenario.
_APP, _REPO = build_generated_app(_CORPUS)
_CLIENT = TestClient(_APP)


@pytest.mark.parametrize(
    "scenario_name,scenario",
    _SCENARIOS,
    ids=[name for name, _ in _SCENARIOS],
)
def test_api_contract_generated_scenario(scenario_name: str, scenario: dict[str, Any]) -> None:
    """Run one api-contract scenario against the GENERATED router."""
    _REPO.reset()
    setup = scenario.get("setup") or {}
    if not setup.get("truncate"):
        _REPO.seed(_SEED_ROWS)
    for req in scenario.get("requests", []):
        _run_request(scenario_name, req)


def _run_request(scenario_name: str, req: dict[str, Any]) -> None:
    method = str(req["method"]).upper()
    path = str(req["path"])
    body = req.get("body")
    expect = req["expect"]
    expect_status = int(expect["status"])
    expect_body = expect.get("body")

    kwargs: dict[str, Any] = {}
    if body is not None:
        kwargs["json"] = body
    response = _CLIENT.request(method, path, **kwargs)
    parsed = _parse_response_body(response.text)
    api_contract_assertions.assert_response(
        scenario_name=scenario_name,
        request_id=str(req.get("id", "?")),
        expect_status=expect_status,
        expect_body=expect_body,
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
