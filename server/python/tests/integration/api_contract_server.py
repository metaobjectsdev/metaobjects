"""FastAPI app factory mirroring what ``router_generator`` emits for the
``Author`` entity from the api-contract-conformance corpus.

Why hand-rolled (vs running ``router_generator`` + a real consumer): the
generator emits a router that depends on a consumer-supplied
``AuthorRepository`` protocol implementation; for a 10-route contract test,
hand-wiring an equivalent FastAPI app + a thin psycopg-like repo against
the testcontainer is the minimum-friction path. The handler shape, status
codes, and wire envelopes mirror the generator output byte-for-byte (and
the cross-port Java / Kotlin / C# servers). The corpus is the contract
both must satisfy.

Backend: pg8000 (pure-python DB-API driver — same driver used by the
existing ``query_runner.py``). Schema is applied with raw DDL because
this test asserts the API surface, not the migrate pipeline.
"""
from __future__ import annotations

from contextlib import closing
from datetime import datetime
from typing import Any

import pg8000.dbapi as pg8000
from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse, Response

from .postgres_container import PostgresInfo


# Mirrors the TS / Java / Kotlin / C# server SORT_ALLOWLIST. Closed set —
# fields outside it elicit the cross-port 400 invalid_sort envelope.
_SORT_ALLOWLIST: frozenset[str] = frozenset({"id", "name", "createdAt"})

# ISO-8601 without zone, matching the seed.json + cross-port wire format.
_TIMESTAMP_FMT = "%Y-%m-%dT%H:%M:%S"


# ---------------------------------------------------------------------------
# Repository — thin psycopg-style wrapper around pg8000 with the connection
# info held by closure. We open a fresh connection per request to avoid
# threading state through the FastAPI dependency-injection lifecycle for
# what is fundamentally a test fixture.
# ---------------------------------------------------------------------------


class AuthorRepository:
    """Direct-JDBC-equivalent repo against the test Postgres instance."""

    def __init__(self, info: PostgresInfo) -> None:
        self._info = info

    # ----- Schema lifecycle -------------------------------------------------

    def create_schema(self) -> None:
        """CREATE TABLE — mirrors ``AuthorApiServer.java`` schema."""
        self._exec(
            'CREATE TABLE IF NOT EXISTS "authors" ('
            '    id BIGSERIAL PRIMARY KEY,'
            '    name VARCHAR(100) NOT NULL,'
            '    bio VARCHAR(1000),'
            '    "createdAt" TIMESTAMP NOT NULL'
            ')'
        )

    def truncate(self) -> None:
        """TRUNCATE ... RESTART IDENTITY — for the list-empty scenario."""
        self._exec('TRUNCATE TABLE "authors" RESTART IDENTITY')

    def apply_seed(self, rows: list[dict[str, Any]]) -> None:
        """Insert seed rows with explicit ids, then bump the sequence so the
        next implicit-id insert lands at max(id) + 1 (matches the Java +
        Kotlin reference runners — required so ``create-201`` lands at a
        deterministic id).
        """
        self.truncate()
        with closing(self._connect()) as conn:
            cur = conn.cursor()
            try:
                for r in rows:
                    cur.execute(
                        'INSERT INTO "authors" (id, name, bio, "createdAt") '
                        'VALUES (%s, %s, %s, %s)',
                        (int(r["id"]), r["name"], r.get("bio"), _parse_timestamp(r["createdAt"])),
                    )
                cur.execute(
                    "SELECT setval(pg_get_serial_sequence('authors', 'id'), "
                    "COALESCE((SELECT MAX(id) FROM authors), 1))"
                )
                conn.commit()
            finally:
                cur.close()

    # ----- Query verbs ------------------------------------------------------

    def list(self, limit: int | None, offset: int, sort_field: str, sort_dir: str) -> list[dict[str, Any]]:
        sql = 'SELECT id, name, bio, "createdAt" FROM "authors"'
        sql += f' ORDER BY "{sort_field}" {sort_dir}'
        if limit is not None:
            sql += f" LIMIT {int(limit)}"
        sql += f" OFFSET {int(offset)}"
        with closing(self._connect()) as conn:
            cur = conn.cursor()
            try:
                cur.execute(sql)
                return [_row_to_dict(row) for row in cur.fetchall()]
            finally:
                cur.close()

    def count(self) -> int:
        with closing(self._connect()) as conn:
            cur = conn.cursor()
            try:
                cur.execute('SELECT COUNT(*) FROM "authors"')
                return int(cur.fetchone()[0])
            finally:
                cur.close()

    def find_by_id(self, ident: int) -> dict[str, Any] | None:
        with closing(self._connect()) as conn:
            cur = conn.cursor()
            try:
                cur.execute(
                    'SELECT id, name, bio, "createdAt" FROM "authors" WHERE id = %s',
                    (int(ident),),
                )
                row = cur.fetchone()
                return _row_to_dict(row) if row is not None else None
            finally:
                cur.close()

    def create(self, dto: dict[str, Any]) -> dict[str, Any]:
        with closing(self._connect()) as conn:
            cur = conn.cursor()
            try:
                cur.execute(
                    'INSERT INTO "authors" (name, bio, "createdAt") '
                    'VALUES (%s, %s, %s) RETURNING id',
                    (dto.get("name"), dto.get("bio"), _parse_timestamp(dto.get("createdAt"))),
                )
                new_id = int(cur.fetchone()[0])
                conn.commit()
            finally:
                cur.close()
        row = self.find_by_id(new_id)
        if row is None:
            raise RuntimeError("create: row vanished between INSERT and SELECT")
        return row

    def update(self, ident: int, dto: dict[str, Any]) -> dict[str, Any] | None:
        # Dynamic SET clause — only update keys present in the body.
        set_clauses: list[str] = []
        values: list[Any] = []
        if "name" in dto:
            set_clauses.append("name = %s")
            values.append(dto["name"])
        if "bio" in dto:
            set_clauses.append("bio = %s")
            values.append(dto["bio"])
        if "createdAt" in dto:
            set_clauses.append('"createdAt" = %s')
            values.append(_parse_timestamp(dto["createdAt"]))
        if not set_clauses:
            return None  # nothing to update — runner maps this to 400 elsewhere if needed
        sql = 'UPDATE "authors" SET ' + ", ".join(set_clauses) + " WHERE id = %s"
        values.append(int(ident))
        with closing(self._connect()) as conn:
            cur = conn.cursor()
            try:
                cur.execute(sql, tuple(values))
                affected = cur.rowcount
                conn.commit()
            finally:
                cur.close()
        if affected == 0:
            return None
        return self.find_by_id(int(ident))

    def delete(self, ident: int) -> bool:
        with closing(self._connect()) as conn:
            cur = conn.cursor()
            try:
                cur.execute('DELETE FROM "authors" WHERE id = %s', (int(ident),))
                deleted = cur.rowcount
                conn.commit()
                return deleted > 0
            finally:
                cur.close()

    # ----- Plumbing ---------------------------------------------------------

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


# ---------------------------------------------------------------------------
# FastAPI app factory
# ---------------------------------------------------------------------------


def make_app(repo: AuthorRepository) -> FastAPI:
    """Build a FastAPI app exposing the Author CRUD contract.

    Routes mirror the ``router_generator`` output (mount under ``/api/authors``,
    PATCH+PUT both reach update, ``withCount=1`` toggles the envelope, etc.).
    """
    app = FastAPI()

    @app.exception_handler(404)
    async def _default_404(_req: Request, _exc: Any) -> JSONResponse:
        # Cross-port not_found envelope; any unrouted GET / unknown id ends up here.
        return JSONResponse(status_code=404, content={"error": "not_found"})

    # GET /api/authors
    @app.get("/api/authors")
    def list_authors(
        limit: int | None = None,
        offset: int | None = None,
        sort: str | None = None,
        withCount: int | None = None,  # noqa: N803 — match wire param name exactly
    ) -> Any:
        actual_offset = offset if offset is not None else 0
        sort_field, sort_dir = "id", "ASC"
        if sort is not None:
            parts = sort.split(":", 1)
            field = parts[0]
            if field not in _SORT_ALLOWLIST:
                return JSONResponse(status_code=400, content={"error": "invalid_sort"})
            direction = parts[1].lower() if len(parts) == 2 else "asc"
            if direction not in ("asc", "desc"):
                return JSONResponse(status_code=400, content={"error": "invalid_sort"})
            sort_field, sort_dir = field, direction.upper()
        rows = repo.list(limit, actual_offset, sort_field, sort_dir)
        if withCount == 1:
            return {"rows": rows, "total": repo.count()}
        return rows

    # GET /api/authors/{id}
    @app.get("/api/authors/{author_id}")
    def get_author(author_id: int) -> Any:
        row = repo.find_by_id(author_id)
        if row is None:
            return JSONResponse(status_code=404, content={"error": "not_found"})
        return row

    # POST /api/authors
    @app.post("/api/authors", status_code=status.HTTP_201_CREATED)
    def create_author(dto: dict[str, Any]) -> Any:
        return repo.create(dto)

    # PATCH + PUT /api/authors/{id}
    @app.patch("/api/authors/{author_id}")
    @app.put("/api/authors/{author_id}")
    def update_author(author_id: int, dto: dict[str, Any]) -> Any:
        saved = repo.update(author_id, dto)
        if saved is None:
            return JSONResponse(status_code=404, content={"error": "not_found"})
        return saved

    # DELETE /api/authors/{id}
    @app.delete("/api/authors/{author_id}", status_code=status.HTTP_204_NO_CONTENT)
    def delete_author(author_id: int) -> Response:
        if not repo.delete(author_id):
            return JSONResponse(status_code=404, content={"error": "not_found"})
        return Response(status_code=204)

    return app


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_timestamp(s: Any) -> datetime:
    if isinstance(s, datetime):
        return s
    return datetime.strptime(str(s), _TIMESTAMP_FMT)


def _row_to_dict(row: Any) -> dict[str, Any]:
    """Normalize a (id, name, bio, createdAt) tuple to the wire shape.

    ``createdAt`` is normalized to ISO-8601-without-zone matching the seed.
    """
    ident, name, bio, created = row
    return {
        "id": int(ident),
        "name": name,
        "bio": bio,
        "createdAt": created.strftime(_TIMESTAMP_FMT) if created is not None else None,
    }
