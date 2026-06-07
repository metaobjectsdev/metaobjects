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
# inject/scope/strip. Per the corpus README ("#### TPH scenarios"), TypeScript
# ships it today and the Java / Kotlin / Python / C# runtimes gain it in their
# Tier-4 slice; until then those ports SKIP the ``tph-*`` scenarios (do not delete
# them — implement the runtime support, then run them green). Out of scope for the
# W2b write-verb / resolution-key hardening.
EXPECTED_FAILURES: dict[str, str] = {
    "tph-insert-then-find-by-id": "runtime TPH support (Tier-4) — see corpus README",
    "tph-insert-three-subtypes-list": "runtime TPH support (Tier-4) — see corpus README",
    "tph-no-cross-subtype-update": "runtime TPH support (Tier-4) — see corpus README",
    "tph-update-subtype-only-column": "runtime TPH support (Tier-4) — see corpus README",
}

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
