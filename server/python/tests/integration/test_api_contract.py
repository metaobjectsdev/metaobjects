"""Cross-port API contract conformance — Python reference runner.

One pytest invocation per scenario in
``fixtures/api-contract-conformance/scenarios/``. Each invocation spins up
a fresh Postgres testcontainer, builds the FastAPI app, walks the scenario's
requests via ``TestClient``, and asserts each response against the cross-port
``expect.body.*`` vocabulary.

Mirrors ``ApiContractConformanceTest.java`` (in
``server/java/integration-tests``) and ``ApiContractConformanceTest.kt`` (in
``server/java/integration-tests-kotlin``). FastAPI ``TestClient`` is the
simplest path here (no port binding, no HTTP plumbing) — equivalent in
contract terms to the JDK ``HttpServer`` + raw ``HttpClient`` shape the
Java runner uses.

Run on-demand (Docker must be available):

    cd server/python
    uv run --extra dev pytest tests/integration/test_api_contract.py -v
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient

from . import api_contract_assertions
from .api_contract_server import AuthorRepository, make_app
from .postgres_container import PostgresContainer


# ---------------------------------------------------------------------------
# Corpus discovery + scenario loading
# ---------------------------------------------------------------------------


def _find_corpus_root(start: Path | None = None) -> Path:
    """Walk up from cwd to find ``fixtures/api-contract-conformance``."""
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
    """Return ``[(name, raw_scenario_dict), ...]`` sorted by file name."""
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


# ---------------------------------------------------------------------------
# Parameterized test
# ---------------------------------------------------------------------------


_SCENARIOS = _load_scenarios()


@pytest.mark.parametrize(
    "scenario_name,scenario",
    _SCENARIOS,
    ids=[name for name, _ in _SCENARIOS],
)
def test_api_contract_scenario(scenario_name: str, scenario: dict[str, Any]) -> None:
    """Run one api-contract scenario end-to-end (testcontainer + FastAPI + TestClient)."""
    with PostgresContainer() as pg:
        repo = AuthorRepository(pg.info())
        repo.create_schema()
        setup = scenario.get("setup") or {}
        if setup.get("truncate"):
            repo.truncate()
        else:
            repo.apply_seed(_SEED_ROWS)

        app = make_app(repo)
        client = TestClient(app)
        for req in scenario.get("requests", []):
            _run_request(client, scenario_name, req)


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
