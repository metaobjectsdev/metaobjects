"""Parameterized: one test per query .yaml.

Each scenario provisions a fresh Testcontainers Postgres, applies the committed
TS-produced ``canonical/schema.postgres.sql`` verbatim (schema migrations are
TS-only — ADR-0015), then runs the query DSL through the ObjectManager runtime.
"""
from __future__ import annotations

import pytest

from . import query_runner
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


@pytest.mark.parametrize("scenario", _scenarios(), ids=lambda s: s.name)
def test_query_scenario(scenario: QueryScenario) -> None:
    reason = EXPECTED_FAILURES.get(scenario.name)
    if reason:
        pytest.skip(reason)
    with PostgresContainer() as pg:
        query_runner.run(scenario, pg, _CORPUS / "canonical")
