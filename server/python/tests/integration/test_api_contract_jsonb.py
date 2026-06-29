"""Cross-port api-contract conformance for the ``field.string @dbColumnType:jsonb``
open bag — Python, BOTH lanes.

Drives the ``fixtures/api-contract-conformance/jsonb/`` scenario over HTTP
against:
  1. the HAND-ROLLED reference server (``api_contract_jsonb_server.py``,
     FastAPI + pg8000 over a Postgres testcontainer), and
  2. the GENERATED router (``generated_jsonb_app.py``, ``render_router`` output
     for ``Document`` + in-memory seam, no Testcontainers).

The contract: a posted JSON object on the open-bag field round-trips as an
object, never a JSON-encoded string. The reference lane needs Docker; the
generated lane does not.

Run on-demand:

    cd server/python
    uv run --extra dev pytest tests/integration/test_api_contract_jsonb.py -v
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient

from . import api_contract_assertions
from .api_contract_jsonb_server import DocumentRepository, make_jsonb_app
from .generated_jsonb_app import build_generated_jsonb_app
from .postgres_container import PostgresContainer


def _find_jsonb_corpus(start: Path | None = None) -> Path:
    cur = (start or Path.cwd()).resolve()
    while cur != cur.parent:
        candidate = cur / "fixtures" / "api-contract-conformance" / "jsonb"
        if candidate.is_dir():
            return candidate
        cur = cur.parent
    raise RuntimeError(
        f"Could not find fixtures/api-contract-conformance/jsonb from {Path.cwd().resolve()}"
    )


_CORPUS = _find_jsonb_corpus()


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
        raise RuntimeError("jsonb/seed.json: missing 'rows' array")
    return rows


_SEED_ROWS = _load_seed_rows()
_SCENARIOS = _load_scenarios()


# --------------------------------------------------------------------------
# Lane 1 — hand-rolled reference server (Postgres testcontainer)
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "scenario_name,scenario",
    _SCENARIOS,
    ids=[name for name, _ in _SCENARIOS],
)
def test_jsonb_reference_scenario(scenario_name: str, scenario: dict[str, Any]) -> None:
    with PostgresContainer() as pg:
        repo = DocumentRepository(pg.info())
        repo.create_schema()
        setup = scenario.get("setup") or {}
        if setup.get("truncate"):
            repo.truncate()
        else:
            repo.apply_seed(_SEED_ROWS)

        client = TestClient(make_jsonb_app(repo))
        for req in scenario.get("requests", []):
            _run_request(client, scenario_name, req)


# --------------------------------------------------------------------------
# Lane 2 — generated router (in-memory seam, no Docker)
# --------------------------------------------------------------------------


_GEN_APP, _GEN_REPO = build_generated_jsonb_app(_CORPUS)
_GEN_CLIENT = TestClient(_GEN_APP)


@pytest.mark.parametrize(
    "scenario_name,scenario",
    _SCENARIOS,
    ids=[name for name, _ in _SCENARIOS],
)
def test_jsonb_generated_scenario(scenario_name: str, scenario: dict[str, Any]) -> None:
    _GEN_REPO.reset()
    setup = scenario.get("setup") or {}
    if not setup.get("truncate"):
        _GEN_REPO.seed(_SEED_ROWS)
    for req in scenario.get("requests", []):
        _run_request(_GEN_CLIENT, scenario_name, req)


# --------------------------------------------------------------------------
# Shared request driver
# --------------------------------------------------------------------------


def _run_request(client: TestClient, scenario_name: str, req: dict[str, Any]) -> None:
    method = str(req["method"]).upper()
    path = str(req["path"])
    body = req.get("body")
    expect = req["expect"]
    expect_status = int(expect["status"])
    expect_body = expect.get("body")

    kwargs: dict[str, Any] = {}
    if body is not None:
        kwargs["json"] = body
    response = client.request(method, path, **kwargs)
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
