"""Run a QueryScenario end-to-end."""
from __future__ import annotations

import json
from contextlib import closing
from pathlib import Path
from typing import Any

import pg8000.dbapi as pg8000

from metaobjects import load_directory
from metaobjects.runtime import ObjectManager, PostgresDriver

from .normalization import canonical_row_set_json, canonical_rows_json, normalize_row
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
            # FR-017 TPH: an op marked `expect-error: true` (a cross-subtype write)
            # MUST be rejected by the runtime — a raise is the pass (mirrors TS/C#).
            if spec.expect_error:
                try:
                    _execute_spec(om, spec)
                except Exception:
                    continue  # rejected as required
                raise AssertionError(
                    f"{scenario.source_path} / {spec.name}: expected the {spec.op} to "
                    f"FAIL (expect-error: true) but it succeeded"
                )
            actual = _execute_spec(om, spec)
            # The OID map from the just-run query supplies the int4-vs-int8
            # wire discriminator the native row values can't carry (ADR-0019).
            _assert_result(scenario.source_path, spec, actual, om.last_column_oids)


# ----------------------------------------------------------------------------
# DSL → ObjectManager
# ----------------------------------------------------------------------------


def _execute_spec(om: ObjectManager, spec: QuerySpec) -> Any:
    if spec.op == "create":
        # FR-017 TPH: INSERT a row through the runtime write path, returning the
        # inserted row (asserted as a single row, like get/update). A subtype
        # create injects its discriminator value.
        if not spec.data:
            raise ValueError(f"{spec.name}: op:create requires 'data'")
        return om.create(spec.entity, spec.data)
    if spec.op == "get":
        if not spec.by:
            raise ValueError(f"{spec.name}: op:get requires 'by'")
        # by is a single-field PK lookup; pass first value.
        first_value = next(iter(spec.by.values()))
        return om.find_by_id(spec.entity, first_value)
    if spec.op == "update":
        if not spec.by:
            raise ValueError(f"{spec.name}: op:update requires 'by' (the record key)")
        if not spec.data:
            raise ValueError(f"{spec.name}: op:update requires 'data'")
        ids = list(spec.by.values())
        if len(ids) != 1:
            raise ValueError(f"{spec.name}: op:update supports single-field 'by' only")
        # if_missing="throw" so a no-match (cross-subtype / absent) update raises and the
        # DSL's `expect-error` op is satisfied — mirrors the TS runner's ifMissing:"throw".
        return om.update(spec.entity, ids[0], spec.data, if_missing="throw")
    if spec.op == "delete":
        if not spec.by:
            raise ValueError(f"{spec.name}: op:delete requires 'by' (the record key)")
        ids = list(spec.by.values())
        if len(ids) != 1:
            raise ValueError(f"{spec.name}: op:delete supports single-field 'by' only")
        # Returns a boolean (true = a row was deleted). `expect: true|false`.
        return om.delete(spec.entity, ids[0])
    if spec.op == "count":
        return om.count(spec.entity, spec.filter)
    if spec.op == "relate":
        if not spec.by:
            raise ValueError(f"{spec.name}: op:relate requires 'by' (source record key)")
        if not spec.relation:
            raise ValueError(f"{spec.name}: op:relate requires 'relation'")
        return om.relate(spec.entity, spec.by, spec.relation)
    if spec.op == "roundtrip":
        # WRITE round-trip: INSERT the row through the runtime write path (NOT raw
        # SQL), read it back by PK so the write codec + read path are both
        # exercised. The inserted row's PK (server-generated or explicit) drives
        # the read-back, so identity-generated PKs (gen_random_uuid / increment)
        # are covered too. The PK is EXCLUDED from the comparison (a generated PK
        # is non-deterministic) — op:get covers PK round-trip.
        if not spec.insert:
            raise ValueError(f"{spec.name}: op:roundtrip requires 'insert' (the row to write)")
        created = om.create(spec.entity, spec.insert)
        pk_field = om.primary_key_field(spec.entity)
        read_back = om.find_by_id(spec.entity, created[pk_field])
        if read_back is not None:
            read_back.pop(pk_field, None)
        return read_back
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


def _assert_result(
    scenario_path: str, spec: QuerySpec, actual: Any, column_oids: dict[str, int]
) -> None:
    expected_json = _canonicalize_expected(spec.expect, spec.op)
    actual_json = _canonicalize_actual(actual, spec.op, column_oids)
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
    # `delete` returns a boolean outcome (true = a row was deleted).
    if op == "delete":
        return str(expect is True)
    # `roundtrip` reads the inserted row back by PK → a single-row result,
    # asserted exactly like `get`. `update` reads the UPDATE ... RETURNING row
    # back the same way. `create` returns the INSERT ... RETURNING row.
    if op in ("get", "roundtrip", "update", "create"):
        if expect is None:
            return "null"
        return json.dumps(normalize_row(expect), sort_keys=True, separators=(",", ":"))
    # `relate` (M:N navigation) is a SET — order is not part of the contract, so
    # both sides sort by per-row canonical JSON for a deterministic, port-agnostic
    # comparison. `list` keeps its order (the scenario pins it via `sort:`).
    if op == "relate":
        return canonical_row_set_json(expect or [])
    # op:list
    if expect is None:
        return "[]"
    return canonical_rows_json(expect)


def _canonicalize_actual(actual: Any, op: str, column_oids: dict[str, int]) -> str:
    if op == "count":
        return str(int(actual) if actual is not None else 0)
    # `delete` returns a boolean — handle BEFORE the dict/normalize_row path
    # (a bool has no ``.items()``; that is the normalization.py:48 AttributeError).
    if op == "delete":
        return str(actual is True)
    if actual is None:
        return "null" if op != "relate" else "[]"
    if op in ("get", "roundtrip", "update", "create"):
        return json.dumps(
            normalize_row(actual, column_oids), sort_keys=True, separators=(",", ":")
        )
    if op == "relate":
        rows = actual if isinstance(actual, list) else [actual]
        return canonical_row_set_json(rows, column_oids)
    return canonical_rows_json(actual, column_oids)
