"""FR-044 — cross-port API contract conformance for a VIEW-BACKED ``object.report``.

Drives ``fixtures/api-contract-conformance/report/`` against the GENERATED routers for the
four served reports (the deployed artifact), with a read-only in-memory repo behind each
generated consumer seam, seeded from ``seed.json``'s ``reports`` half.

Generated lane only, by design — see the corpus README. The thing under test is whether
Python's GENERATOR emits a keyless read-only surface for a report: row model, filter
allowlist, router. A hand-rolled reference server would answer every scenario by
construction and prove nothing.

Run on-demand:

    cd server/python
    uv run --extra integration pytest tests/integration/test_api_contract_report.py -v
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient

from . import api_contract_assertions
from .generated_report_app import (
    SERVED_REPORTS,
    UNSERVED_REPORT,
    build_generated_report_app,
    seed_rows,
)


def _find_corpus_root(start: Path | None = None) -> Path:
    cur = (start or Path.cwd()).resolve()
    while cur != cur.parent:
        candidate = cur / "fixtures" / "api-contract-conformance" / "report"
        if candidate.is_dir():
            return candidate
        cur = cur.parent
    raise RuntimeError(
        "Could not find fixtures/api-contract-conformance/report from "
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


def _load_seed_reports() -> dict[str, list[dict[str, Any]]]:
    """The seam lane's half of the seed: what the four views return for the base rows."""
    parsed = json.loads((_CORPUS / "seed.json").read_text())
    reports = parsed.get("reports")
    if not isinstance(reports, dict):
        raise RuntimeError("report seed.json: missing 'reports' object")
    return {name: seed_rows(reports[name]) for name in SERVED_REPORTS}


_SEED = _load_seed_reports()
_SCENARIOS = _load_scenarios()

_APP, _REPOS, _EMITTED = build_generated_report_app(_CORPUS)
_CLIENT = TestClient(_APP)


def test_exactly_the_served_reports_are_generated() -> None:
    """The sourceless report generates nothing; each served one generates its row model,
    allowlist and router (and the names module is not a route concern, so it is not asked
    for here: only the three generators the lane runs)."""
    assert len(SERVED_REPORTS) == 4
    for report, stem in SERVED_REPORTS.items():
        assert f"{report}.py" in _EMITTED
        assert f"{stem}_filter_allowlist.py" in _EMITTED
        assert f"{stem}_router.py" in _EMITTED
    assert not any(UNSERVED_REPORT in f or "invoice_days" in f for f in _EMITTED), _EMITTED
    # The base entities were not asked for, so no writable router sits beside the reports.
    for base in ("invoice", "product", "sale"):
        assert f"{base}_router.py" not in _EMITTED


def test_the_unserved_report_mounts_no_route() -> None:
    assert _CLIENT.get("/api/invoice_days").status_code == 404


@pytest.mark.parametrize(
    "scenario_name,scenario",
    _SCENARIOS,
    ids=[name for name, _ in _SCENARIOS],
)
def test_report_scenario(scenario_name: str, scenario: dict[str, Any]) -> None:
    """Run one report api-contract scenario against the GENERATED routers."""
    for report, repo in _REPOS.items():
        repo.reset()
        if not (scenario.get("setup") or {}).get("truncate"):
            repo.seed(_SEED[report])
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
