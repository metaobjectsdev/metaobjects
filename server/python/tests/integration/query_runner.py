"""Run a QueryScenario end-to-end."""
from __future__ import annotations

import json
from contextlib import closing
from pathlib import Path
from typing import Any

import pg8000.dbapi as pg8000

from metaobjects import load_directory
from metaobjects.migrate import build_expected_schema, diff, emit_postgres
from metaobjects.migrate.types import SchemaSnapshot
from metaobjects.runtime import ObjectManager, PostgresDriver

from .normalization import canonical_rows_json, normalize_row
from .postgres_container import PostgresContainer
from .scenarios import QueryScenario, QuerySpec


def run(scenario: QueryScenario, pg: PostgresContainer, canonical_dir: Path) -> None:
    info = pg.info()

    # 1. Apply the canonical schema (engine full-CREATE).
    root_for_bootstrap = _load(canonical_dir)
    expected = build_expected_schema(root_for_bootstrap)
    up = emit_postgres(diff(expected, SchemaSnapshot()))
    _execute(info, up)

    # 2. Seed data.
    if scenario.seed_data and scenario.seed_data.strip():
        _execute(info, scenario.seed_data)

    # 3. Run queries through ObjectManager.
    with closing(pg8000.connect(
        host=info.host, port=info.port, user=info.user, password=info.password, database=info.database,
    )) as conn:
        driver = PostgresDriver(conn)
        om = ObjectManager(root_for_bootstrap, driver)
        for spec in scenario.queries:
            actual = _execute_spec(om, spec)
            _assert_result(scenario.source_path, spec, actual)


# ----------------------------------------------------------------------------
# DSL → ObjectManager
# ----------------------------------------------------------------------------


def _execute_spec(om: ObjectManager, spec: QuerySpec) -> Any:
    if spec.op == "get":
        if not spec.by:
            raise ValueError(f"{spec.name}: op:get requires 'by'")
        # by is a single-field PK lookup; pass first value.
        first_value = next(iter(spec.by.values()))
        return om.find_by_id(spec.entity, first_value)
    if spec.op == "count":
        return om.count(spec.entity, spec.filter)
    # op:list
    sort = [(s.field, s.dir) for s in spec.sort] if spec.sort else None
    return om.find_many(
        spec.entity,
        spec.filter,
        sort=sort,
        limit=spec.limit,
        offset=spec.offset,
    )


# ----------------------------------------------------------------------------
# Postgres helpers + assertions
# ----------------------------------------------------------------------------


def _load(metadata_dir: Path):
    result = load_directory(metadata_dir)
    if result.errors:
        formatted = "; ".join(f"{e.code}: {e.message}" for e in result.errors)
        raise RuntimeError(f"{metadata_dir}: metadata did not load cleanly: {formatted}")
    return result.root


def _execute(info: Any, sql: str) -> None:
    if not sql.strip():
        return
    with closing(pg8000.connect(
        host=info.host, port=info.port, user=info.user, password=info.password, database=info.database,
    )) as conn:
        cur = conn.cursor()
        try:
            cur.execute(sql)
            conn.commit()
        finally:
            cur.close()


def _assert_result(scenario_path: str, spec: QuerySpec, actual: Any) -> None:
    expected_json = _canonicalize_expected(spec.expect, spec.op)
    actual_json = _canonicalize_actual(actual, spec.op)
    if expected_json != actual_json:
        raise AssertionError(
            f"{scenario_path} / {spec.name}: result mismatch\n"
            f"  expected: {expected_json}\n"
            f"  actual:   {actual_json}"
        )


def _canonicalize_expected(expect: Any, op: str) -> str:
    if op == "count":
        n = int(expect) if not isinstance(expect, int) else expect
        return str(n)
    if op == "get":
        if expect is None:
            return "null"
        return json.dumps(normalize_row(expect), sort_keys=True, separators=(",", ":"))
    # op:list
    if expect is None:
        return "[]"
    return canonical_rows_json(expect)


def _canonicalize_actual(actual: Any, op: str) -> str:
    if op == "count":
        return str(int(actual) if actual is not None else 0)
    if actual is None:
        return "null"
    if op == "get":
        return json.dumps(normalize_row(actual), sort_keys=True, separators=(",", ":"))
    return canonical_rows_json(actual)
