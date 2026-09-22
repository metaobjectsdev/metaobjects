"""F22 — cross-port API contract conformance for a VIEW-ONLY projection.

Drives ``fixtures/api-contract-conformance/projection/`` against the GENERATED
``InvoiceSummary`` router (the deployed artifact), with a read-only in-memory
repo behind the generated consumer seam.

Generated lane only, by design — see the corpus README. The thing under test is
whether Python's GENERATOR emits routes for a view-only projection at all: it
did not, until F22. A hand-rolled reference server would answer every scenario
by construction and prove nothing.

Run on-demand:

    cd server/python
    uv run --extra dev pytest tests/integration/test_api_contract_projection.py -v
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient

from . import api_contract_assertions
from .generated_projection_app import build_generated_projection_app


def _find_corpus_root(start: Path | None = None) -> Path:
    cur = (start or Path.cwd()).resolve()
    while cur != cur.parent:
        candidate = cur / "fixtures" / "api-contract-conformance" / "projection"
        if candidate.is_dir():
            return candidate
        cur = cur.parent
    raise RuntimeError(
        "Could not find fixtures/api-contract-conformance/projection from "
        f"{Path.cwd().resolve()}"
    )


_CORPUS = _find_corpus_root()


def _load_scenarios() -> list[tuple[str, dict[str, Any]]]:
    out: list[tuple[str, dict[str, Any]]] = []
    for path in sorted((_CORPUS / "scenarios").glob("*.yaml")):
        raw = yaml.safe_load(path.read_text())
        out.append((raw["name"], raw))
    if not out:
        raise RuntimeError(f"no scenarios found under {_CORPUS / 'scenarios'}")
    return out


def _load_seed_rows() -> list[dict[str, Any]]:
    """The corpus seeds the BASE table; the view is a straight projection of it,
    so the read-only repo is seeded with the same rows."""
    parsed = json.loads((_CORPUS / "seed.json").read_text())
    rows = parsed.get("invoices")
    if not isinstance(rows, list):
        raise RuntimeError("projection seed.json: missing 'invoices' array")
    return rows


_SEED_ROWS = _load_seed_rows()
_SCENARIOS = _load_scenarios()

_APP, _REPO = build_generated_projection_app(_CORPUS)
_CLIENT = TestClient(_APP)


@pytest.mark.parametrize(
    "scenario_name,scenario",
    _SCENARIOS,
    ids=[name for name, _ in _SCENARIOS],
)
def test_projection_scenario(scenario_name: str, scenario: dict[str, Any]) -> None:
    """Run one projection api-contract scenario against the GENERATED router."""
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

    kwargs: dict[str, Any] = {}
    if body is not None:
        kwargs["json"] = body
    response = _CLIENT.request(method, path, **kwargs)
    api_contract_assertions.assert_response(
        scenario_name=scenario_name,
        request_id=str(req.get("id", "?")),
        expect_status=int(expect["status"]),
        expect_body=expect.get("body"),
        status=response.status_code,
        body=_parse_response_body(response.text),
    )


def _parse_response_body(text: str | None) -> Any:
    if text is None or text == "":
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text
