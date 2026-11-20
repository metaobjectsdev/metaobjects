"""#484 — TPH sibling credential, api-contract conformance, GENERATED lane.

A column one subtype of a single-table hierarchy marks as a credential (``view.password``) is a
credential for the whole table: the base's and both subtypes' filter and sort allowlists leave it
out, so a request naming it is refused with ``invalid_filter_field`` / ``invalid_sort``. Drives the
shared ``fixtures/api-contract-conformance/secret-fields/tph/`` scenarios through the same
generated TPH router and in-memory seam as ``test_api_contract_tph_generated.py``.

Run on-demand:

    cd server/python
    uv run --extra dev pytest tests/integration/test_api_contract_secret_fields_tph.py -v
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient

from . import api_contract_assertions
from .generated_tph_app import build_generated_tph_app


def _find_dir(start: Path | None = None) -> Path:
    cur = (start or Path.cwd()).resolve()
    while cur != cur.parent:
        candidate = cur / "fixtures" / "api-contract-conformance" / "secret-fields" / "tph"
        if candidate.is_dir():
            return candidate
        cur = cur.parent
    raise RuntimeError(
        f"Could not find fixtures/api-contract-conformance/secret-fields/tph from {Path.cwd().resolve()}"
    )


_DIR = _find_dir()
_SEED: dict[str, list[dict[str, Any]]] = json.loads((_DIR / "seed.json").read_text())
_SCENARIOS = [
    (raw["name"], raw)
    for raw in (yaml.safe_load(p.read_text()) for p in sorted((_DIR / "scenarios").glob("*.yaml")))
]
_APP, _REPO = build_generated_tph_app(_DIR)
_CLIENT = TestClient(_APP)


@pytest.mark.parametrize("scenario_name,scenario", _SCENARIOS, ids=[name for name, _ in _SCENARIOS])
def test_api_contract_secret_fields_tph_scenario(scenario_name: str, scenario: dict[str, Any]) -> None:
    _REPO.reset()
    _REPO.seed(_SEED["auths"])
    for req in scenario.get("requests", []):
        response = _CLIENT.request(str(req["method"]).upper(), str(req["path"]))
        text = response.text
        parsed: Any = None
        if text:
            try:
                parsed = api_contract_assertions.parse_body(text)
            except json.JSONDecodeError:
                parsed = text
        expect = req["expect"]
        api_contract_assertions.assert_response(
            scenario_name=scenario_name,
            request_id=str(req.get("id", "?")),
            expect_status=int(expect["status"]),
            expect_body=expect.get("body"),
            status=response.status_code,
            body=parsed,
        )
