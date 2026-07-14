"""FastAPI app factory mirroring what ``router_generator`` emits for the
``Author`` entity from the api-contract-conformance corpus.

Why hand-rolled (vs running ``router_generator`` + a real consumer): the
generator emits a router that depends on a consumer-supplied
``AuthorRepository`` protocol implementation; for a 20-route contract test,
hand-wiring an equivalent FastAPI app + a thin psycopg-like repo against
the testcontainer is the minimum-friction path. The handler shape, status
codes, and wire envelopes mirror the generator output byte-for-byte (and
the cross-port Java / Kotlin / C# servers). The corpus is the contract
both must satisfy.

Filter handling (FR-009): the FastAPI app parses
``filter[<field>][<op>]=<value>`` via the shared
``metaobjects.codegen.runtime.filter_parser`` (the same helper the
generated routers import), validates against the per-entity allowlist
below, and builds a pg8000-parameterized WHERE clause. Mirrors the
cross-port wire grammar exactly.

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

from metaobjects.codegen.runtime.filter_parser import FilterPredicate, parse_filter

from .postgres_container import PostgresInfo


# Mirrors the TS / Java / Kotlin / C# server SORT_ALLOWLIST. Closed set —
# fields outside it elicit the cross-port 400 invalid_sort envelope.
_SORT_ALLOWLIST: frozenset[str] = frozenset({"id", "name", "createdAt"})

# Per-entity FR-009 filter allowlist for Author. Mirror of what
# `filter_allowlist_generator` would emit for the Author entity (the
# integration test is hand-wired so we duplicate the constants here; the
# codegen-side `test_filter_allowlist_generator.py` covers the
# generator-emitted shape against a separate Author fixture).
_AUTHOR_FILTER_FIELDS: frozenset[str] = frozenset({"id", "name", "bio", "createdAt"})
_AUTHOR_FILTER_OPS_BY_FIELD: dict[str, frozenset[str]] = {
    "id": frozenset({"eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"}),
    "name": frozenset({"eq", "ne", "in", "like", "isNull"}),
    "bio": frozenset({"eq", "ne", "in", "like", "isNull"}),
    "createdAt": frozenset({"eq", "ne", "gt", "gte", "lt", "lte", "isNull"}),
}

# Substrate subtypes per field — drives pg8000 value coercion for the
# parameter binds (the cross-port parser is substrate-agnostic; the
# scalar→DB-type coercion lives in the repository / server layer).
_AUTHOR_FIELD_SUBTYPE: dict[str, str] = {
    "id": "number",
    "name": "string",
    "bio": "string",
    "createdAt": "datetime",
}

# FR-009 scalar-comparison op → SQL operator. Excludes the two shape-special
# ops (isNull → IS NULL/IS NOT NULL, in → expanded IN list) which need bespoke
# emit paths in _build_where.
_SCALAR_OP_SQL: dict[str, str] = {
    "eq": "=",
    "ne": "<>",
    "gt": ">",
    "gte": ">=",
    "lt": "<",
    "lte": "<=",
    "like": "LIKE",
}

# ISO-8601 without zone, matching the seed.json + cross-port wire format.
_TIMESTAMP_FMT = "%Y-%m-%dT%H:%M:%S"


# Sentinel for coercion failure (mirrors AuthorApiServer.java).
_INVALID_COERCION = object()


# FR-036 — the Author entity's @maxLength caps (name ≤ 100, bio ≤ 1000). The
# reference lane hand-codes what the generated lane runs through the Pydantic
# model, so both lanes reject an over-length PRESENT value with the cross-port
# 400 envelope (POST always; PATCH only on a present, non-null value).
_MAX_LENGTHS: dict[str, int] = {"name": 100, "bio": 1000}


def _length_violation(dto: dict[str, Any]) -> bool:
    """True iff a present string value in *dto* exceeds its @maxLength cap. A
    None / absent value never trips this (present-null clears; absent is untouched)."""
    for field, cap in _MAX_LENGTHS.items():
        value = dto.get(field)
        if isinstance(value, str) and len(value) > cap:
            return True
    return False


def _coerce_scalar(raw: str, sub_type: str) -> Any:
    """Coerce a raw URL-decoded string to a pg8000-bindable value for a single
    column subtype. Returns _INVALID_COERCION on parse failure."""
    if sub_type == "string":
        return raw
    if sub_type == "number":
        try:
            return int(raw)
        except (TypeError, ValueError):
            return _INVALID_COERCION
    if sub_type == "datetime":
        try:
            return _parse_timestamp(raw)
        except (TypeError, ValueError):
            return _INVALID_COERCION
    if sub_type == "boolean":
        if raw == "true":
            return True
        if raw == "false":
            return False
        return _INVALID_COERCION
    return _INVALID_COERCION


def _build_where(predicates: list[FilterPredicate]) -> tuple[str, list[Any], str | None]:
    """Build a `" WHERE ..."` clause + bound params from `predicates`.

    Returns `(sql_fragment, bind_params, error_envelope_key)`. On a
    coercion failure (numeric-op on non-numeric URL value), returns
    `("", [], "invalid_filter_value")` so the caller can emit the
    cross-port 400 envelope. Multiple predicates AND together.
    """
    if not predicates:
        return "", [], None
    sql_parts: list[str] = []
    params: list[Any] = []
    for p in predicates:
        col = f'"{p.field}"'
        sub_type = _AUTHOR_FIELD_SUBTYPE.get(p.field, "string")
        op = p.op
        value = p.value
        if op == "isNull":
            sql_parts.append(f"{col} IS NULL" if value is True else f"{col} IS NOT NULL")
            continue
        if op == "in":
            assert isinstance(value, list)
            coerced: list[Any] = []
            for raw in value:
                c = _coerce_scalar(raw, sub_type)
                if c is _INVALID_COERCION:
                    return "", [], "invalid_filter_value"
                coerced.append(c)
            placeholders = ", ".join(["%s"] * len(coerced))
            sql_parts.append(f"{col} IN ({placeholders})")
            params.extend(coerced)
            continue
        # eq / ne / gt / gte / lt / lte / like → single scalar bind.
        scalar = _coerce_scalar(str(value), sub_type)
        if scalar is _INVALID_COERCION:
            return "", [], "invalid_filter_value"
        sql_op = _SCALAR_OP_SQL.get(op)
        if sql_op is None:
            return "", [], "invalid_filter_value"
        sql_parts.append(f"{col} {sql_op} %s")
        params.append(scalar)
    return " WHERE " + " AND ".join(sql_parts), params, None


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

    def list(
        self,
        limit: int | None,
        offset: int,
        sort_field: str,
        sort_dir: str,
        where_clause: str = "",
        where_params: list[Any] | None = None,
    ) -> list[dict[str, Any]]:
        sql = 'SELECT id, name, bio, "createdAt" FROM "authors"'
        sql += where_clause
        sql += f' ORDER BY "{sort_field}" {sort_dir}'
        if limit is not None:
            sql += f" LIMIT {int(limit)}"
        sql += f" OFFSET {int(offset)}"
        params = tuple(where_params or ())
        with closing(self._connect()) as conn:
            cur = conn.cursor()
            try:
                if params:
                    cur.execute(sql, params)
                else:
                    cur.execute(sql)
                return [_row_to_dict(row) for row in cur.fetchall()]
            finally:
                cur.close()

    def count(
        self,
        where_clause: str = "",
        where_params: list[Any] | None = None,
    ) -> int:
        sql = 'SELECT COUNT(*) FROM "authors"' + where_clause
        params = tuple(where_params or ())
        with closing(self._connect()) as conn:
            cur = conn.cursor()
            try:
                if params:
                    cur.execute(sql, params)
                else:
                    cur.execute(sql)
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
        request: Request,
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
        # FR-009: parse `filter[<field>][<op>]=<value>` from the raw query
        # params via the shared codegen-runtime helper, then coerce to a
        # pg8000-parameterized WHERE clause + bind params (column subtype
        # drives the coercion). Same parser the generated routers call.
        filter_result = parse_filter(
            request.query_params, _AUTHOR_FILTER_FIELDS, _AUTHOR_FILTER_OPS_BY_FIELD
        )
        if filter_result.error_envelope is not None:
            return JSONResponse(status_code=400, content=filter_result.error_envelope)
        where_clause, where_params, where_err = _build_where(filter_result.predicates)
        if where_err is not None:
            return JSONResponse(status_code=400, content={"error": where_err})
        rows = repo.list(limit, actual_offset, sort_field, sort_dir, where_clause, where_params)
        if withCount == 1:
            return {"rows": rows, "total": repo.count(where_clause, where_params)}
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
        # FR-036: reject an over-length field before persisting (cross-port 400).
        if _length_violation(dto):
            return JSONResponse(status_code=400, content={"error": "validation"})
        return repo.create(dto)

    # PATCH + PUT /api/authors/{id}
    @app.patch("/api/authors/{author_id}")
    @app.put("/api/authors/{author_id}")
    def update_author(author_id: int, dto: dict[str, Any]) -> Any:
        # FR-035 PATCH-2: an explicit null on a @required field (name / createdAt,
        # per meta.json) is a 400 — a present null on the nullable bio clears it,
        # and an omitted required field is simply untouched (never a 400).
        for _k in ("name", "createdAt"):
            if _k in dto and dto[_k] is None:
                return JSONResponse(status_code=400, content={"error": "validation"})
        # FR-036: reject an over-length PRESENT value with the cross-port 400.
        if _length_violation(dto):
            return JSONResponse(status_code=400, content={"error": "validation"})
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
