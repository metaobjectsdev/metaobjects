"""Parameterized: one test per query .yaml, on Postgres; the FR-044 ``report-*`` scenarios
also on SQLite and MySQL.

Postgres: each scenario provisions a fresh Postgres, applies the committed TS-produced
``canonical/schema.postgres.sql`` verbatim (schema migrations are TS-only -- ADR-0015), then
runs the query DSL through the ObjectManager runtime.

SQLite and MySQL 8.4: the same ``report-*`` scenarios run against the engine's own
TS-produced artifact (``canonical/schema.sqlite.sql`` / ``schema.mysql.sql``), through the
ObjectManager's SQLite and MySQL drivers. The ``expect`` blocks stay the Postgres wire ones;
the runtime decodes each engine's values to the declared field types and the same
serialization boundary canonicalizes them. ``report-relative-date`` carries a per-engine seed
(``seed-data-engine``). One MySQL server serves the whole session; each scenario starts from
an empty schema.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from . import query_runner
from .mysql_container import MySqlInfo
from .postgres_container import PostgresContainer
from .scenarios import QueryScenario, find_corpus_root, load_queries


# Scenarios the Python runtime does not yet satisfy, keyed by scenario name with
# the reason. The TPH (table-per-hierarchy) scenarios require runtime
# single-table-inheritance support — resolving a discriminator subtype's
# inherited fields / identity / shared table via ``extends`` plus discriminator
# inject/scope/strip. FR-017 Tier-4: the Python runtime now ships TPH support
# (ObjectManager discriminator inject/scope/strip + runtime/tph.py), so the
# ``tph-*`` scenarios run green and are no longer skipped.
EXPECTED_FAILURES: dict[str, str] = {}

_CORPUS = find_corpus_root()


def _scenarios() -> list[QueryScenario]:
    return load_queries(_CORPUS / "queries")


def _for(engine: str) -> list[QueryScenario]:
    return [s for s in _scenarios() if s.runs_on(engine)]


@pytest.mark.parametrize("scenario", _for("postgres"), ids=lambda s: s.name)
def test_query_scenario(scenario: QueryScenario) -> None:
    reason = EXPECTED_FAILURES.get(scenario.name)
    if reason:
        pytest.skip(reason)
    with PostgresContainer() as pg:
        query_runner.run(scenario, pg, _CORPUS / "canonical")


def test_the_report_corpus_is_present() -> None:
    """A rename of the ``report-`` prefix must not silently empty the extra-engine lanes."""
    assert len([s for s in _scenarios() if s.name.startswith("report-")]) == 24
    assert {s.name for s in _for("sqlite")} >= {"decimal-exact-15", "report-decimal-exact-15"}
    assert "decimal-exact" not in {s.name for s in _for("sqlite")}
    assert {"decimal-exact", "report-decimal-exact"} <= {s.name for s in _for("mysql")}


def test_an_unknown_engine_name_is_a_runner_error(tmp_path: Path) -> None:
    from .scenarios import load_queries

    (tmp_path / "x.yaml").write_text("name: x\nengines: [oracle]\nqueries: []\n")
    with pytest.raises(ValueError, match="unknown engine"):
        load_queries(tmp_path)
    (tmp_path / "x.yaml").write_text("name: x\nengines: []\nqueries: []\n")
    with pytest.raises(ValueError, match="non-empty"):
        load_queries(tmp_path)


@pytest.mark.parametrize("scenario", _for("sqlite"), ids=lambda s: s.name)
def test_report_scenario_on_sqlite(scenario: QueryScenario, tmp_path: Path) -> None:
    query_runner.run_sqlite(scenario, tmp_path / "scenario.db", _CORPUS / "canonical")


@pytest.mark.parametrize("scenario", _for("mysql"), ids=lambda s: s.name)
def test_report_scenario_on_mysql(scenario: QueryScenario, mysql_empty: MySqlInfo) -> None:
    query_runner.run_mysql(scenario, mysql_empty, _CORPUS / "canonical")
