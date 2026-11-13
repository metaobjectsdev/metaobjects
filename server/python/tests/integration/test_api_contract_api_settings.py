"""Cross-port API contract for the project ``api`` block (``api.pagination``, ``api.unknownFields``).

Drives ``fixtures/api-contract-conformance/api-settings/`` against the GENERATED ``Item`` router,
with the settings read from the sub-corpus's own ``.metaobjects/config.json``. Generated lane
only: what is under test is whether the GENERATOR emits routes that honour them.

    cd server/python
    uv run --extra dev pytest tests/integration/test_api_contract_api_settings.py -v
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient

from . import api_contract_assertions
from .generated_api_settings_app import build_api_settings_app


def _find_corpus_root() -> Path:
    cur = Path(__file__).resolve()
    while cur != cur.parent:
        candidate = cur / "fixtures" / "api-contract-conformance" / "api-settings"
        if candidate.is_dir():
            return candidate
        cur = cur.parent
    raise RuntimeError("Could not find fixtures/api-contract-conformance/api-settings")


_CORPUS = _find_corpus_root()
_SCENARIOS = [
    (raw["name"], raw)
    for raw in (yaml.safe_load(p.read_text()) for p in sorted((_CORPUS / "scenarios").glob("*.yaml")))
]
_SEED_ROWS = json.loads((_CORPUS / "seed.json").read_text())["rows"]
_APP, _REPO = build_api_settings_app(_CORPUS)
_CLIENT = TestClient(_APP)


def _parse(text: str | None) -> Any:
    if not text:
        return None
    try:
        return api_contract_assertions.parse_body(text)
    except json.JSONDecodeError:
        return text


@pytest.mark.parametrize("scenario_name,scenario", _SCENARIOS, ids=[n for n, _ in _SCENARIOS])
def test_api_settings_scenario(scenario_name: str, scenario: dict[str, Any]) -> None:
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
