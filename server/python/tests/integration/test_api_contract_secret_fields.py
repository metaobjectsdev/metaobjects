"""#484 — cross-port API contract for credential and ``@formExclude`` fields.

Drives ``fixtures/api-contract-conformance/secret-fields/`` against the GENERATED ``Account``
router. Generated lane only, by design: a hand-rolled reference server would honour the marks
by construction, and what is under test is whether the GENERATOR emits routes that do.

    cd server/python
    uv run --extra dev pytest tests/integration/test_api_contract_secret_fields.py -v
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient

from . import api_contract_assertions
from .generated_secret_fields_app import build_secret_fields_app


def _find_corpus_root() -> Path:
    cur = Path(__file__).resolve()
    while cur != cur.parent:
        candidate = cur / "fixtures" / "api-contract-conformance" / "secret-fields"
        if candidate.is_dir():
            return candidate
        cur = cur.parent
    raise RuntimeError("Could not find fixtures/api-contract-conformance/secret-fields")


_CORPUS = _find_corpus_root()
_SCENARIOS = [
    (raw["name"], raw)
    for raw in (yaml.safe_load(p.read_text()) for p in sorted((_CORPUS / "scenarios").glob("*.yaml")))
]
_SEED_ROWS = json.loads((_CORPUS / "seed.json").read_text())["rows"]
_APP, _REPO = build_secret_fields_app(_CORPUS)
_CLIENT = TestClient(_APP)


def _parse(text: str | None) -> Any:
    if not text:
        return None
    try:
        return api_contract_assertions.parse_body(text)
    except json.JSONDecodeError:
        return text


@pytest.mark.parametrize("scenario_name,scenario", _SCENARIOS, ids=[n for n, _ in _SCENARIOS])
def test_secret_fields_scenario(scenario_name: str, scenario: dict[str, Any]) -> None:
    _REPO.reset()
    _REPO.seed(_SEED_ROWS)
    for req in scenario["requests"]:
        kwargs: dict[str, Any] = {}
        if req.get("body") is not None:
            kwargs["json"] = req["body"]
        response = _CLIENT.request(str(req["method"]).upper(), str(req["path"]), **kwargs)
        expect = req["expect"]
        api_contract_assertions.assert_response(
            scenario_name=scenario_name,
            request_id=str(req.get("id", "?")),
            expect_status=int(expect["status"]),
            expect_body=expect.get("body"),
            status=response.status_code,
            body=_parse(response.text),
        )


def test_denied_columns_never_reach_the_stored_rows() -> None:
    """Behavioural proof for ``pinHash`` too: it is never readable over HTTP, so read the
    rows the generated router left in the repository after the write scenarios ran."""
    _REPO.reset()
    _REPO.seed(_SEED_ROWS)
    for _name, scenario in _SCENARIOS:
        if scenario["name"] != "write-ignores-excluded":
            continue
        for req in scenario["requests"]:
            _CLIENT.request(str(req["method"]).upper(), str(req["path"]), json=req.get("body"))
    stored = {r["id"]: r for r in _REPO._rows}
    for seed in _SEED_ROWS:
        row = stored[seed["id"]]
        assert row["pinHash"] == seed["pinHash"], f"pinHash written on row {seed['id']}"
        assert row["tokenHash"] == seed["tokenHash"], f"tokenHash written on row {seed['id']}"
    created = [r for r in _REPO._rows if r["id"] not in {s["id"] for s in _SEED_ROWS}]
    assert [r["name"] for r in created] == ["Grace Hopper"]
    assert created[0].get("pinHash") is None and created[0].get("tokenHash") is None
    assert {r["name"] for r in _REPO._rows if r["id"] in (1, 2)} == {"Ada L. (probe 2)", "Alan T. (probe)"}
