"""Parameterized: one test per migration .yaml.

Each invocation spins up a fresh Postgres testcontainer, so scenarios are
fully isolated. NOT part of the default ``pytest`` run — the file requires
the ``integration`` extra (pg8000) + a docker daemon, so it's only collected
when the integration suite is explicitly invoked:

    cd server/python && pytest tests/integration -v

(Or via ``scripts/integration-test.sh python``.)
"""
from __future__ import annotations

import pytest

from . import migration_runner
from .postgres_container import PostgresContainer
from .scenarios import MigrationScenario, find_corpus_root, load_migrations


# Scenarios deferred until the underlying Python port gap is closed. Empty
# today — kept as scaffolding matching the C# / Java / TS pattern.
EXPECTED_FAILURES: dict[str, str] = {}


def _scenarios() -> list[MigrationScenario]:
    return load_migrations(find_corpus_root() / "migrations")


@pytest.mark.parametrize("scenario", _scenarios(), ids=lambda s: s.name)
def test_migration_scenario(scenario: MigrationScenario) -> None:
    reason = EXPECTED_FAILURES.get(scenario.name)
    if reason:
        pytest.skip(reason)
    with PostgresContainer() as pg:
        migration_runner.run(scenario, pg)
