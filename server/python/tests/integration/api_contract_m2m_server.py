"""FR-018 Unit 14 — HAND-ROLLED reference lane for the M:N traversal contract.

A FastAPI app exposing the three M:N traversal sub-resources from the shared
``fixtures/api-contract-conformance/m2m/`` corpus, backed by pg8000 against a
per-scenario Testcontainers Postgres:

    GET /api/posts/{id}/tags         hetero (Post —tags→ Tag via PostTag)
    GET /api/persons/{id}/following  directed self-join (@sourceRefField)
    GET /api/persons/{id}/friends    symmetric self-join (@symmetric, union-on-read)

The route wiring + join SQL are declared by hand here (NOT emitted by codegen),
so this lane is an independent witness of the same contract the GENERATED lane
(``test_api_contract_m2m_generated.py``) must also satisfy. The traversal
semantics mirror the cross-port resolver: a two-stage join (junction rows for the
source id → target rows by related id); symmetric unions both junction FK columns
on read and returns the column that is NOT the source id.

Physical schema uses the CROSS-PORT CANONICAL column spelling — the metadata
field names quoted verbatim (``"postId"``, ``"followerId"`` …), matching
``fixtures/persistence-conformance/canonical/schema.postgres.sql``. The source URL
segment is the ENTITY name pluralized (``Person`` → ``/persons``), NOT the
physical ``@table`` (``people``).
"""
from __future__ import annotations

from contextlib import closing
from typing import Any

import pg8000.dbapi as pg8000
from fastapi import FastAPI

from .postgres_container import PostgresInfo

_SCHEMA = (
    'CREATE TABLE IF NOT EXISTS "posts"  ("id" BIGSERIAL PRIMARY KEY, "title" VARCHAR(200) NOT NULL)',
    'CREATE TABLE IF NOT EXISTS "tags"   ("id" BIGSERIAL PRIMARY KEY, "name" VARCHAR(80) NOT NULL)',
    'CREATE TABLE IF NOT EXISTS "post_tags" ("postId" BIGINT NOT NULL, "tagId" BIGINT NOT NULL, PRIMARY KEY ("postId","tagId"))',
    'CREATE TABLE IF NOT EXISTS "people" ("id" BIGSERIAL PRIMARY KEY, "name" VARCHAR(80) NOT NULL)',
    'CREATE TABLE IF NOT EXISTS "follows" ("followerId" BIGINT NOT NULL, "followeeId" BIGINT NOT NULL, PRIMARY KEY ("followerId","followeeId"))',
    'CREATE TABLE IF NOT EXISTS "friendships" ("personAId" BIGINT NOT NULL, "personBId" BIGINT NOT NULL, PRIMARY KEY ("personAId","personBId"))',
)

# Physical table → ordered insert columns, matching the seed.json row shapes.
_SEED_COLUMNS: dict[str, tuple[str, ...]] = {
    "posts": ("id", "title"),
    "tags": ("id", "name"),
    "post_tags": ("postId", "tagId"),
    "people": ("id", "name"),
    "follows": ("followerId", "followeeId"),
    "friendships": ("personAId", "personBId"),
}


class M2mRepository:
    """Direct-pg8000 repo against the per-scenario Postgres instance."""

    def __init__(self, info: PostgresInfo) -> None:
        self._info = info

    # ----- schema / seed ----------------------------------------------------

    def create_schema(self) -> None:
        for ddl in _SCHEMA:
            self._exec(ddl)

    def apply_seed(self, seed: dict[str, list[dict[str, Any]]]) -> None:
        self._exec(
            'TRUNCATE TABLE "posts","tags","post_tags","people","follows","friendships" '
            "RESTART IDENTITY"
        )
        with closing(self._connect()) as conn:
            cur = conn.cursor()
            try:
                for table, cols in _SEED_COLUMNS.items():
                    rows = seed.get(table, [])
                    if not rows:
                        continue
                    col_list = ", ".join(f'"{c}"' for c in cols)
                    placeholders = ", ".join(["%s"] * len(cols))
                    sql = f'INSERT INTO "{table}" ({col_list}) VALUES ({placeholders})'
                    for r in rows:
                        cur.execute(sql, tuple(r[c] for c in cols))
                conn.commit()
            finally:
                cur.close()

    # ----- M:N traversal (the contract under test) --------------------------

    def find_related(
        self,
        source_id: int,
        *,
        junction_table: str,
        target_table: str,
        source_column: str,
        target_column: str,
        target_pk_column: str,
        symmetric: bool,
    ) -> list[dict[str, Any]]:
        """Two-stage join: junction rows for ``source_id`` → related target rows.

        Symmetric: union both junction FK columns; per row the related id is the
        column that is NOT the source id (self-loop relates to the source itself).
        """
        with closing(self._connect()) as conn:
            cur = conn.cursor()
            try:
                if symmetric:
                    cur.execute(
                        f'SELECT "{source_column}", "{target_column}" FROM "{junction_table}" '
                        f'WHERE "{source_column}" = %s OR "{target_column}" = %s',
                        (source_id, source_id),
                    )
                    related = _collect_symmetric(cur.fetchall(), source_id)
                else:
                    cur.execute(
                        f'SELECT "{target_column}" FROM "{junction_table}" '
                        f'WHERE "{source_column}" = %s',
                        (source_id,),
                    )
                    related = _distinct([row[0] for row in cur.fetchall()])

                if not related:
                    return []
                placeholders = ", ".join(["%s"] * len(related))
                cur.execute(
                    f'SELECT * FROM "{target_table}" '
                    f'WHERE "{target_pk_column}" IN ({placeholders})',
                    tuple(related),
                )
                col_names = [d[0] for d in cur.description]
                return [_normalize(dict(zip(col_names, row))) for row in cur.fetchall()]
            finally:
                cur.close()

    # ----- plumbing ---------------------------------------------------------

    def _connect(self) -> Any:
        return pg8000.connect(
            host=self._info.host,
            port=self._info.port,
            user=self._info.user,
            password=self._info.password,
            database=self._info.database,
        )

    def _exec(self, sql: str) -> None:
        with closing(self._connect()) as conn:
            cur = conn.cursor()
            try:
                cur.execute(sql)
                conn.commit()
            finally:
                cur.close()


def make_app(repo: M2mRepository) -> FastAPI:
    """Mount the three M:N traversal sub-resources."""
    app = FastAPI()

    @app.get("/api/posts/{post_id}/tags")
    def posts_tags(post_id: int) -> list[dict[str, Any]]:
        return repo.find_related(
            post_id, junction_table="post_tags", target_table="tags",
            source_column="postId", target_column="tagId", target_pk_column="id",
            symmetric=False,
        )

    @app.get("/api/persons/{person_id}/following")
    def persons_following(person_id: int) -> list[dict[str, Any]]:
        return repo.find_related(
            person_id, junction_table="follows", target_table="people",
            source_column="followerId", target_column="followeeId", target_pk_column="id",
            symmetric=False,
        )

    @app.get("/api/persons/{person_id}/friends")
    def persons_friends(person_id: int) -> list[dict[str, Any]]:
        return repo.find_related(
            person_id, junction_table="friendships", target_table="people",
            source_column="personAId", target_column="personBId", target_pk_column="id",
            symmetric=True,
        )

    return app


# ---------------------------------------------------------------------------
# Resolution helpers (shared by both lanes' repos)
# ---------------------------------------------------------------------------


def _distinct(values: list[Any]) -> list[Any]:
    seen: dict[str, Any] = {}
    for v in values:
        if v is None:
            continue
        seen.setdefault(str(v), v)
    return list(seen.values())


def _collect_symmetric(rows: list[tuple[Any, Any]], source_id: int) -> list[Any]:
    source_key = str(source_id)
    seen: dict[str, Any] = {}
    for a, b in rows:
        a_is_source = a is not None and str(a) == source_key
        other = b if a_is_source else a
        if other is None:
            continue
        seen.setdefault(str(other), other)
    return list(seen.values())


def _normalize(row: dict[str, Any]) -> dict[str, Any]:
    """Coerce id to int for the cross-port wire shape (pg8000 may return a
    differing native type for BIGINT)."""
    out = dict(row)
    if "id" in out and out["id"] is not None:
        out["id"] = int(out["id"])
    return out
