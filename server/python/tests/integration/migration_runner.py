"""Run a MigrationScenario end-to-end."""
from __future__ import annotations

import tempfile
from contextlib import closing
from pathlib import Path
from typing import Any

import pg8000.dbapi as pg8000

from metaobjects import load_directory
from metaobjects.migrate import build_expected_schema, diff, emit_postgres
from metaobjects.migrate.types import Change, ChangeStatus
from metaobjects.runtime.object_manager import _coerce_for_contract

from .normalization import canonical_rows_json
from .postgres_container import PostgresContainer
from .scenarios import MigrationScenario


def run(scenario: MigrationScenario, pg: PostgresContainer) -> None:
    info = pg.info()

    # 1. Bootstrap the seed-metadata schema, if any.
    if scenario.seed_metadata_dir:
        seed_sql = _full_create(Path(scenario.seed_metadata_dir))
        _execute(info, seed_sql)

    # 2. Seed data.
    if scenario.seed_data and scenario.seed_data.strip():
        _execute(info, scenario.seed_data)

    # 3. Run diff + emit against the target metadata.
    target = _resolve_target(scenario)
    root = _load(target)
    expected = build_expected_schema(root)
    actual = _actual_snapshot_from_seed(scenario)
    changes = diff(expected, actual)
    up = emit_postgres(changes)

    # 4. Assertions.
    _assert_blocked(scenario, changes)
    _assert_up_contains(scenario, up)
    _assert_up_empty(scenario, up)

    # 5. Apply + post-query.
    auq = scenario.expect.apply_up_then_query
    blocked = [c for c in changes if c.status.state == "blocked"]
    if auq is not None and not blocked and up.strip():
        _execute(info, up)
        actual_rows = _query_rows(info, auq.sql)
        _assert_rows(scenario.source_path, "apply-up-then-query", auq.rows, actual_rows)


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------


def _full_create(metadata_dir: Path) -> str:
    """Bootstrap path — diff metadata against empty actual snapshot."""
    root = _load(metadata_dir)
    expected = build_expected_schema(root)
    changes = diff(expected, _empty_snapshot())
    return emit_postgres(changes)


def _load(metadata_dir: Path):
    result = load_directory(metadata_dir)
    if result.errors:
        formatted = "; ".join(f"{e.code}: {e.message}" for e in result.errors)
        raise RuntimeError(f"{metadata_dir}: metadata did not load cleanly: {formatted}")
    return result.root


def _empty_snapshot():
    # Lazy import to keep this module's import surface narrow.
    from metaobjects.migrate import SchemaSnapshot
    return SchemaSnapshot()


def _actual_snapshot_from_seed(scenario: MigrationScenario):
    """Surface the seed-metadata schema as the diff's 'actual'.

    Cross-port shape: when seed-metadata is set, build expected_schema from it
    and treat that as the live DB shape — the diff then surfaces the right
    AddColumn / DropTable / etc. against the target metadata.
    """
    if not scenario.seed_metadata_dir:
        return _empty_snapshot()
    root = _load(Path(scenario.seed_metadata_dir))
    return build_expected_schema(root)


def _resolve_target(scenario: MigrationScenario) -> Path:
    if scenario.target_metadata_dir:
        return Path(scenario.target_metadata_dir)
    if scenario.target_metadata_inline:
        tmp = Path(tempfile.mkdtemp(prefix="metaobjects-scenario-"))
        (tmp / "meta.json").write_text(scenario.target_metadata_inline)
        return tmp
    raise ValueError(f"{scenario.source_path}: missing target-metadata / target-metadata-inline")


def _execute(info: Any, sql: str) -> None:
    with closing(pg8000.connect(
        host=info.host, port=info.port, user=info.user, password=info.password, database=info.database,
    )) as conn:
        cur = conn.cursor()
        try:
            cur.execute(sql)
            conn.commit()
        finally:
            cur.close()


def _query_rows(info: Any, sql: str) -> list[dict[str, Any]]:
    with closing(pg8000.connect(
        host=info.host, port=info.port, user=info.user, password=info.password, database=info.database,
    )) as conn:
        cur = conn.cursor()
        try:
            cur.execute(sql)
            cols = [d[0] for d in cur.description]
            oids = [d[1] for d in cur.description]
            return [
                {c: _coerce_for_contract(v, oids[i]) for i, (c, v) in enumerate(zip(cols, row))}
                for row in cur.fetchall()
            ]
        finally:
            cur.close()


# ----------------------------------------------------------------------------
# Assertions
# ----------------------------------------------------------------------------


def _assert_blocked(scenario: MigrationScenario, changes: list[Change]) -> None:
    actual = [c for c in changes if c.status.state == "blocked"]
    expected = scenario.expect.blocked
    if not expected:
        if actual:
            raise AssertionError(
                f"{scenario.source_path}: expected no blocked changes; got: "
                + "; ".join(_format_change(c) for c in actual)
            )
        return
    formatted = [_format_change(c) for c in actual]
    for want in expected:
        hit = any(f.startswith(want.kind) and want.reason_contains in f for f in formatted)
        if not hit:
            raise AssertionError(
                f"{scenario.source_path}: expected blocked '{want.kind}' "
                f"containing '{want.reason_contains}'; got: {'; '.join(formatted)}"
            )


def _format_change(c: Change) -> str:
    """Format a Change as the cross-port 'PascalKind: reason' vocabulary."""
    pascal = "".join(p.capitalize() for p in c.kind.split("-"))
    return f"{pascal}: {c.status.blocked_reason or ''}"


def _assert_up_contains(scenario: MigrationScenario, up: str) -> None:
    for needle in scenario.expect.up_contains:
        if needle not in up:
            raise AssertionError(
                f"{scenario.source_path}: up SQL did not contain expected substring '{needle}'.\n"
                f"--- up SQL ---\n{up}"
            )


def _assert_up_empty(scenario: MigrationScenario, up: str) -> None:
    if scenario.expect.up_empty is not True:
        return
    if up.strip():
        raise AssertionError(
            f"{scenario.source_path}: expected up-empty: true but got non-empty SQL:\n{up}"
        )


def _assert_rows(
    scenario_path: str, query_name: str,
    expected: list[dict[str, Any]], actual: list[dict[str, Any]],
) -> None:
    expected_json = canonical_rows_json(expected)
    actual_json = canonical_rows_json(actual)
    if expected_json != actual_json:
        raise AssertionError(
            f"{scenario_path} / {query_name}: row mismatch\n"
            f"  expected: {expected_json}\n"
            f"  actual:   {actual_json}"
        )
