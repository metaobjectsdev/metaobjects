"""FR-044 — cross-port API contract conformance for a VIEW-BACKED ``object.report``.

Drives ``fixtures/api-contract-conformance/report/`` against the GENERATED routers for the
served reports (the deployed artifact), on a REAL database: the corpus' TypeScript-produced
``schema.<engine>.sql`` (four tables and nine views) is executed verbatim on Postgres, SQLite
and MySQL 8.4, the base tables are seeded from ``seed.json``, and the repository behind each
generated consumer seam is the adopter-owned ``ObjectManager`` implementation reading the
real view. Every scenario runs on every engine.

Generated lane only, by design -- see the corpus README. The thing under test is whether
Python's GENERATOR emits a keyless read-only surface for a report (row model, filter
allowlist, router) and whether it answers correctly over the view's rows. A hand-rolled
reference server would answer every scenario by construction and prove nothing.

Run on-demand:

    cd server/python
    uv run --extra dev --extra integration pytest tests/integration/test_api_contract_report.py -v
"""
from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from collections.abc import Iterator
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
    generate_reports,
)
from .mysql_container import MySqlInfo
from .normalization import canonical_row_set_json
from .report_lane import ENGINES, ReportLane, open_lane


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


_SCENARIOS = _load_scenarios()


class _Lane:
    """A provisioned engine, its seeded tables, and a client over the generated routers."""

    def __init__(self, lane: ReportLane) -> None:
        self.lane = lane
        app, self.emitted = build_generated_report_app(_CORPUS, lane.om)
        self.client = TestClient(app)


@pytest.fixture(scope="module", params=ENGINES)
def lane(request: pytest.FixtureRequest, tmp_path_factory: pytest.TempPathFactory) -> Iterator[_Lane]:
    """One database per engine for the module; a Postgres container, a SQLite file, or the
    session's MySQL server reset to an empty database. Every test of the module runs once
    per engine."""
    engine: str = request.param
    mysql: MySqlInfo | None = None
    if engine == "mysql":
        from .mysql_container import reset_database

        mysql = request.getfixturevalue("mysql_server")
        assert mysql is not None
        reset_database(mysql)
    with open_lane(
        engine, _CORPUS, sqlite_path=tmp_path_factory.mktemp("report") / "report.db", mysql=mysql
    ) as opened:
        yield _Lane(opened)


def test_exactly_the_served_reports_are_generated() -> None:
    """The sourceless report generates nothing; each served one generates its row model,
    allowlist and router (and the names module is not a route concern, so it is not asked
    for here: only the three generators the lane runs)."""
    emitted = generate_reports(_CORPUS).emitted
    assert len(SERVED_REPORTS) == 12
    for report, stem in SERVED_REPORTS.items():
        assert f"{report}.py" in emitted
        assert f"{stem}_filter_allowlist.py" in emitted
        assert f"{stem}_router.py" in emitted
    # `report-export` is wired in this lane: one shared writer, and an export module per report.
    assert "report_export_writer.py" in emitted
    for stem in SERVED_REPORTS.values():
        assert f"{stem}_export.py" in emitted
    assert not any(UNSERVED_REPORT in f or "invoice_days" in f for f in emitted), emitted
    # The base entities were not asked for, so no writable router sits beside the reports.
    for base in ("category", "invoice", "product", "sale"):
        assert f"{base}_router.py" not in emitted


def test_the_unserved_report_mounts_no_route(lane: _Lane) -> None:
    assert lane.client.get("/api/invoice_days").status_code == 404


def test_the_views_return_what_the_corpus_expects(lane: _Lane) -> None:
    """The seed's ``reports`` half is what the views return for the base rows: the lane reads
    the REAL views and holds them to it, so the scenarios below stand on the seed and not on
    a view that drifted from it. Order is not part of the comparison; a decimal is compared
    by value (its spelling is each engine's own)."""
    lane.lane.reseed(empty=False)
    for report in SERVED_REPORTS:
        actual = lane.lane.om.find_many(report)
        assert canonical_row_set_json(actual) == canonical_row_set_json(
            lane.lane.expected_reports.get(report, [])
        ), f"{report} on {lane.lane.engine}"


@pytest.mark.parametrize(
    "scenario_name,scenario",
    _SCENARIOS,
    ids=[name for name, _ in _SCENARIOS],
)
def test_report_scenario(lane: _Lane, scenario_name: str, scenario: dict[str, Any]) -> None:
    """Run one report api-contract scenario against the GENERATED routers, over the views."""
    lane.lane.reseed(empty=bool((scenario.get("setup") or {}).get("truncate")))
    for req in scenario.get("requests", []):
        _run_request(lane.client, scenario_name, req)


def _run_request(client: TestClient, scenario_name: str, req: dict[str, Any]) -> None:
    method = str(req["method"]).upper()
    path = str(req["path"])
    body = req.get("body")
    expect = req["expect"]
    where = f"{scenario_name} / {req.get('id', '?')}"

    kwargs: dict[str, Any] = {}
    if body is not None:
        kwargs["json"] = body
    if req.get("headers"):
        kwargs["headers"] = {str(k): str(v) for k, v in req["headers"].items()}
    response = client.request(method, path, **kwargs)

    expect_body = expect.get("body")
    # `text` and `xml` are the report-export body keys (report/README.md): the exact UTF-8 text,
    # and an XML infoset compare. Neither is JSON, so they are checked here, not by the
    # shared assertion engine.
    raw = expect_body if isinstance(expect_body, dict) and ("text" in expect_body or "xml" in expect_body) else None
    api_contract_assertions.assert_response(
        scenario_name=scenario_name,
        request_id=str(req.get("id", "?")),
        expect_status=int(expect["status"]),
        expect_body=None if raw is not None else expect_body,
        status=response.status_code,
        body=_parse_response_body(response.text),
    )
    for name, want in (expect.get("headers") or {}).items():
        actual = response.headers.get(name)
        assert actual == want, f"{where}: header {name!r}: expected {want!r}, got {actual!r}"
    if raw is not None and "text" in raw:
        assert response.content.decode("utf-8") == raw["text"], f"{where}: text body"
    if raw is not None and "xml" in raw:
        assert _infoset(ET.fromstring(response.content)) == _infoset(ET.fromstring(raw["xml"])), (
            f"{where}: xml body {response.text!r}"
        )


def _infoset(el: ET.Element) -> tuple[Any, ...]:
    """An XML element as (name, attributes, text, children): names, attributes, text and
    order, with whitespace between elements ignored. ElementTree expands a namespaced name
    (``xsi:nil``) to its URI form, so the prefix is not part of the compare."""
    children = tuple(_infoset(c) for c in el)
    text = el.text if not children else (el.text or "").strip() or None
    return (el.tag, tuple(sorted(el.attrib.items())), text or None, children)


def _parse_response_body(text: str | None) -> Any:
    if text is None or text == "":
        return None
    try:
        return api_contract_assertions.parse_body(text)
    except json.JSONDecodeError:
        return text
