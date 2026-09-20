"""FR-018 Unit 14 — HAND-ROLLED reference lane for the M:N traversal contract.

A FastAPI app exposing the three M:N traversal sub-resources from the shared
``fixtures/api-contract-conformance/m2m/`` corpus, backed by pg8000 against a
per-scenario Testcontainers Postgres:

    GET /api/posts/{id}/tags         hetero (Post —tags→ Tag via PostTag)
    GET /api/persons/{id}/following  directed self-join (@sourceRefField)
    GET /api/persons/{id}/friends    symmetric self-join (@symmetric, union-on-read)

Plus, FW-8 (FR-018 x FR-017 — M:N traversal inside a TPH hierarchy), over the
``Account`` discriminator base (``@discriminator: "kind"``, subtypes
``MemberAccount`` / ``GuestAccount``, abstract mid level ``ScopedAccount``):

    GET /api/accounts/{id}/badges            base-declared, UNGATED (rule a) —
                                              every row of the shared table is a
                                              legitimate source.
    GET /api/accounts/member/{id}/badges     the SAME relationship, also mounted
                                              under the subtype segment (rule b) —
                                              gated: an id that isn't a Member
                                              answers [] (rule c), not a sibling's
                                              rows.
    GET /api/accounts/member/{id}/scopes     declared on the ABSTRACT mid level
                                              ScopedAccount — has no path of its
                                              own, served only under the one
                                              concrete descendant beneath it
                                              (rule d).
    GET /api/accounts/member/{id}/interests  declared on the CONCRETE subtype
                                              MemberAccount itself (rule b).
    GET /api/posts/{id}/reviewers            a non-TPH source (Post) whose
                                              relationship TARGET is a TPH
                                              subtype (MemberAccount) — the
                                              target's rows live in the shared
                                              `accounts` table, so the join
                                              additionally filters on the
                                              target's own discriminator value
                                              ("Member") to exclude sibling
                                              subtypes (Guest).

There is no `/api/accounts/guest/*` route wired here: no scenario in the shared
corpus exercises the Guest segment, and this lane hand-implements exactly the
routes its scenarios need (unlike the GENERATED lane, whose router IS the real
generator output and therefore emits every subtype segment unconditionally).

The route wiring + join SQL are declared by hand here (NOT emitted by codegen),
so this lane is an independent witness of the same contract the GENERATED lane
(``test_api_contract_m2m_generated.py``) must also satisfy. The traversal
semantics mirror the cross-port resolver: a two-stage join (junction rows for the
source id → target rows by related id); symmetric unions both junction FK columns
on read and returns the column that is NOT the source id. A TPH subtype-scoped
mount additionally verifies the source id names a row of that subtype BEFORE
joining (rule c); a TPH-target relationship additionally filters the joined rows
to the target's own discriminator value.

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
    # FW-8: the TPH discriminator base — ONE shared table for Account /
    # MemberAccount / GuestAccount (single-table inheritance); "kind" is the
    # discriminator column, "karma" (Member-only) and "invitedBy" (Guest-only)
    # are nullable since a row of the other subtype never sets them.
    'CREATE TABLE IF NOT EXISTS "accounts" ('
    '"id" BIGSERIAL PRIMARY KEY, "kind" VARCHAR(20) NOT NULL, '
    '"handle" VARCHAR(80) NOT NULL, "karma" INTEGER, "invitedBy" VARCHAR(80))',
    'CREATE TABLE IF NOT EXISTS "account_tags" ("accountId" BIGINT NOT NULL, "tagId" BIGINT NOT NULL, PRIMARY KEY ("accountId","tagId"))',
    'CREATE TABLE IF NOT EXISTS "scoped_account_tags" ("accountId" BIGINT NOT NULL, "tagId" BIGINT NOT NULL, PRIMARY KEY ("accountId","tagId"))',
    'CREATE TABLE IF NOT EXISTS "member_account_tags" ("accountId" BIGINT NOT NULL, "tagId" BIGINT NOT NULL, PRIMARY KEY ("accountId","tagId"))',
    'CREATE TABLE IF NOT EXISTS "post_reviewers" ("postId" BIGINT NOT NULL, "accountId" BIGINT NOT NULL, PRIMARY KEY ("postId","accountId"))',
    'CREATE TABLE IF NOT EXISTS "blog_categories" ("id" BIGSERIAL PRIMARY KEY, "name" VARCHAR(80) NOT NULL)',
)

_TABLES = (
    "posts", "tags", "post_tags", "people", "follows", "friendships",
    "accounts", "account_tags", "scoped_account_tags", "member_account_tags",
    "post_reviewers", "blog_categories",
)

# Physical table → ordered insert columns, matching the seed.json row shapes.
_SEED_COLUMNS: dict[str, tuple[str, ...]] = {
    "posts": ("id", "title"),
    "tags": ("id", "name"),
    "post_tags": ("postId", "tagId"),
    "people": ("id", "name"),
    "follows": ("followerId", "followeeId"),
    "friendships": ("personAId", "personBId"),
    "accounts": ("id", "kind", "handle", "karma", "invitedBy"),
    "account_tags": ("accountId", "tagId"),
    "scoped_account_tags": ("accountId", "tagId"),
    "member_account_tags": ("accountId", "tagId"),
    "post_reviewers": ("postId", "accountId"),
    "blog_categories": ("id", "name"),
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
        table_list = ",".join(f'"{t}"' for t in _TABLES)
        self._exec(f"TRUNCATE TABLE {table_list} RESTART IDENTITY")
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

    # ----- plain collection (route-spelling gate) ---------------------------

    def list_all(self, table: str) -> list[dict[str, Any]]:
        """Every row of ``table``, ordered by id — the shape a generated
        collection route returns. Used only by the route-spelling scenario,
        whose subject is the URL, not the query."""
        with closing(self._connect()) as conn:
            cur = conn.cursor()
            try:
                cur.execute(f'SELECT * FROM "{table}" ORDER BY "id"')
                col_names = [d[0] for d in cur.description]
                return [_normalize(dict(zip(col_names, row))) for row in cur.fetchall()]
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

    # ----- FW-8: M:N traversal inside a TPH hierarchy ------------------------

    def find_related_scoped(
        self,
        source_id: int,
        *,
        subtype: str | None,
        discriminator_table: str = "accounts",
        discriminator_column: str = "kind",
        junction_table: str,
        target_table: str,
        source_column: str,
        target_column: str,
        target_pk_column: str,
    ) -> list[dict[str, Any]]:
        """Rule (c): a subtype-scoped mount verifies the source id names a row
        of ``subtype`` in the shared discriminator table BEFORE ever joining —
        a miss returns ``[]`` rather than reaching the junction, where the FK
        alone cannot tell subtypes apart (it addresses the shared base table).
        ``subtype=None`` (the base-path mount) skips the check entirely — every
        row is a legitimate source there (rule a)."""
        if subtype is not None and not self._row_is_kind(
            source_id, table=discriminator_table, column=discriminator_column, value=subtype
        ):
            return []
        return self.find_related(
            source_id,
            junction_table=junction_table, target_table=target_table,
            source_column=source_column, target_column=target_column,
            target_pk_column=target_pk_column, symmetric=False,
        )

    def find_related_target_scoped(
        self,
        source_id: int,
        *,
        junction_table: str,
        target_table: str,
        source_column: str,
        target_column: str,
        target_pk_column: str,
        target_discriminator_column: str,
        target_discriminator_value: str,
    ) -> list[dict[str, Any]]:
        """FW-8 target side: the relationship's ``@objectRef`` target is a TPH
        subtype, so its rows live in a shared table alongside its siblings — an
        unscoped join cannot tell a genuine match from a same-table sibling.
        Narrow the joined rows to ``target_discriminator_value`` after the join
        (the junction FK itself addresses the shared base table either way)."""
        rows = self.find_related(
            source_id,
            junction_table=junction_table, target_table=target_table,
            source_column=source_column, target_column=target_column,
            target_pk_column=target_pk_column, symmetric=False,
        )
        return [r for r in rows if r.get(target_discriminator_column) == target_discriminator_value]

    def _row_is_kind(self, row_id: int, *, table: str, column: str, value: str) -> bool:
        with closing(self._connect()) as conn:
            cur = conn.cursor()
            try:
                cur.execute(
                    f'SELECT 1 FROM "{table}" WHERE "id" = %s AND "{column}" = %s',
                    (row_id, value),
                )
                return cur.fetchone() is not None
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
    """Mount the M:N traversal sub-resources, plus the one plain collection the
    route-spelling scenario needs."""
    app = FastAPI()

    # The collection segment is the ENTITY NAME snake_cased then pluralized:
    # PostCategory -> /post_categories. Neither retired spelling is mounted, so
    # both 404 by absence.
    @app.get("/api/post_categories")
    def post_categories() -> list[dict[str, Any]]:
        return repo.list_all("blog_categories")

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

    # ----- FW-8: M:N traversal inside a TPH hierarchy (Account) --------------

    @app.get("/api/accounts/{account_id}/badges")
    def accounts_badges(account_id: int) -> list[dict[str, Any]]:
        # Base-declared, UNGATED (rule a): every row of the shared `accounts`
        # table — Member or Guest — is a legitimate source here.
        return repo.find_related(
            account_id, junction_table="account_tags", target_table="tags",
            source_column="accountId", target_column="tagId", target_pk_column="id",
            symmetric=False,
        )

    @app.get("/api/accounts/member/{account_id}/badges")
    def accounts_member_badges(account_id: int) -> list[dict[str, Any]]:
        # The SAME relationship, also mounted under the subtype segment (rule
        # b) — the overlap with the base route above is deliberate.
        return repo.find_related_scoped(
            account_id, subtype="Member",
            junction_table="account_tags", target_table="tags",
            source_column="accountId", target_column="tagId", target_pk_column="id",
        )

    @app.get("/api/accounts/member/{account_id}/scopes")
    def accounts_member_scopes(account_id: int) -> list[dict[str, Any]]:
        # Declared on the ABSTRACT mid level ScopedAccount — no path of its
        # own; served only under its one concrete descendant (rule d).
        return repo.find_related_scoped(
            account_id, subtype="Member",
            junction_table="scoped_account_tags", target_table="tags",
            source_column="accountId", target_column="tagId", target_pk_column="id",
        )

    @app.get("/api/accounts/member/{account_id}/interests")
    def accounts_member_interests(account_id: int) -> list[dict[str, Any]]:
        # Declared on the CONCRETE subtype MemberAccount itself (rule b).
        return repo.find_related_scoped(
            account_id, subtype="Member",
            junction_table="member_account_tags", target_table="tags",
            source_column="accountId", target_column="tagId", target_pk_column="id",
        )

    @app.get("/api/posts/{post_id}/reviewers")
    def posts_reviewers(post_id: int) -> list[dict[str, Any]]:
        # FW-8 target side: Post is NOT TPH, but @objectRef targets MemberAccount
        # — a TPH subtype whose rows live in the shared `accounts` table. Narrow
        # to "Member" so a Guest co-tenant (post 2 → account 2, deliberately
        # seeded) never leaks through.
        return repo.find_related_target_scoped(
            post_id, junction_table="post_reviewers", target_table="accounts",
            source_column="postId", target_column="accountId", target_pk_column="id",
            target_discriminator_column="kind", target_discriminator_value="Member",
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
