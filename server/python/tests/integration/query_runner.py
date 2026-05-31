"""Run a QueryScenario end-to-end."""
from __future__ import annotations

import json
from contextlib import closing
from pathlib import Path
from typing import Any

import pg8000.dbapi as pg8000

from metaobjects import load_directory
from metaobjects.runtime import ObjectManager, PostgresDriver

from .normalization import canonical_rows_json, normalize_row
from .postgres_container import PostgresContainer
from .scenarios import QueryScenario, QuerySpec

#: The single TS-produced schema artifact every port's query-runner executes
#: verbatim (ADR-0015). Lives under the corpus ``canonical/`` directory.
SCHEMA_ARTIFACT_FILE = "schema.postgres.sql"


def run(scenario: QueryScenario, pg: PostgresContainer, canonical_dir: Path) -> None:
    info = pg.info()

    # 1. Provision the schema by executing the committed TS-produced DDL
    #    artifact verbatim — schema migrations are TS-only (ADR-0015), so no
    #    port synthesizes its conformance schema from metadata anymore.
    _apply_schema_artifact(info, canonical_dir / SCHEMA_ARTIFACT_FILE)

    # Metadata is still loaded — but only for entity → row mapping (table +
    # column names, field types), never to derive DDL.
    root_for_bootstrap = _load(canonical_dir)

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


def _apply_schema_artifact(info: Any, artifact: Path) -> None:
    """Execute the committed Postgres DDL artifact statement-by-statement.

    The artifact is a flat list of CREATE / ALTER statements terminated by ``;``
    with no embedded semicolons (no functions / dollar-quoting), so a naive
    split on ``;`` is sufficient and keeps us off any driver multi-statement
    quirk. Comment-only lines (``--``) are stripped before splitting.
    """
    text = artifact.read_text()
    statements = [s.strip() for s in _strip_comments(text).split(";")]
    with closing(pg8000.connect(
        host=info.host, port=info.port, user=info.user, password=info.password, database=info.database,
    )) as conn:
        cur = conn.cursor()
        try:
            for stmt in statements:
                if stmt:
                    cur.execute(stmt)
            conn.commit()
        finally:
            cur.close()


def _strip_comments(sql: str) -> str:
    lines = [ln for ln in sql.splitlines() if not ln.lstrip().startswith("--")]
    return "\n".join(lines)


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
