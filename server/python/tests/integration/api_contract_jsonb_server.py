"""Hand-rolled reference FastAPI app for the ``Document`` entity from the
``api-contract-conformance/jsonb/`` corpus.

The contract under test is the ``field.string @dbColumnType:jsonb`` open bag:
a posted JSON object must round-trip as an object (never a JSON-encoded
string). Pared down from ``api_contract_server.py`` (the Author reference) —
the jsonb scenario only POSTs + GETs by id, so this server implements just
those verbs.

Backend: pg8000 (pure-python DB-API; same driver as ``api_contract_server.py``).
``payload`` is a bare ``JSONB`` column — the open bag holds any JSON value.
pg8000 auto-decodes jsonb to a native Python object on read; on write the
value is ``json.dumps``-serialized and bound with a ``::jsonb`` cast.
"""
from __future__ import annotations

import json
from contextlib import closing
from typing import Any

import pg8000.dbapi as pg8000
from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse

from .postgres_container import PostgresInfo


class DocumentRepository:
    """Direct-JDBC-equivalent repo against the test Postgres instance."""

    def __init__(self, info: PostgresInfo) -> None:
        self._info = info

    def create_schema(self) -> None:
        self._exec(
            'CREATE TABLE IF NOT EXISTS "documents" ('
            "    id BIGSERIAL PRIMARY KEY,"
            "    title VARCHAR(200) NOT NULL,"
            "    payload JSONB"
            ")"
        )

    def truncate(self) -> None:
        self._exec('TRUNCATE TABLE "documents" RESTART IDENTITY')

    def apply_seed(self, rows: list[dict[str, Any]]) -> None:
        """Insert seed rows with explicit ids, then bump the sequence so the
        next implicit-id POST lands at max(id) + 1 (the GET-after-POST
        contract relies on a deterministic id)."""
        self.truncate()
        with closing(self._connect()) as conn:
            cur = conn.cursor()
            try:
                for r in rows:
                    cur.execute(
                        'INSERT INTO "documents" (id, title, payload) '
                        "VALUES (%s, %s, %s::jsonb)",
                        (int(r["id"]), r["title"], _dump_payload(r.get("payload"))),
                    )
                cur.execute(
                    "SELECT setval(pg_get_serial_sequence('documents', 'id'), "
                    "COALESCE((SELECT MAX(id) FROM documents), 1))"
                )
                conn.commit()
            finally:
                cur.close()

    def find_by_id(self, ident: int) -> dict[str, Any] | None:
        with closing(self._connect()) as conn:
            cur = conn.cursor()
            try:
                cur.execute(
                    'SELECT id, title, payload FROM "documents" WHERE id = %s',
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
                    'INSERT INTO "documents" (title, payload) '
                    "VALUES (%s, %s::jsonb) RETURNING id",
                    (dto.get("title"), _dump_payload(dto.get("payload"))),
                )
                new_id = int(cur.fetchone()[0])
                conn.commit()
            finally:
                cur.close()
        created = self.find_by_id(new_id)
        if created is None:
            raise RuntimeError("create: row vanished between INSERT and SELECT")
        return created

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


def make_jsonb_app(repo: DocumentRepository) -> FastAPI:
    app = FastAPI()

    @app.exception_handler(404)
    async def _default_404(_req: Request, _exc: Any) -> JSONResponse:
        return JSONResponse(status_code=404, content={"error": "not_found"})

    @app.get("/api/documents/{document_id}")
    def get_document(document_id: int) -> Any:
        row = repo.find_by_id(document_id)
        if row is None:
            return JSONResponse(status_code=404, content={"error": "not_found"})
        return row

    @app.post("/api/documents", status_code=status.HTTP_201_CREATED)
    def create_document(dto: dict[str, Any]) -> Any:
        return repo.create(dto)

    return app


def _dump_payload(value: Any) -> Any:
    """jsonb bind: a dict/list is ``json.dumps``-serialized for the ``::jsonb``
    cast; ``None`` stays ``None`` (SQL NULL); a pre-serialized string passes
    through."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return json.dumps(value)


def _row_to_dict(row: Any) -> dict[str, Any]:
    ident, title, payload = row
    # pg8000 auto-decodes jsonb → native Python object; if a driver returned raw
    # text we'd parse it, but the open-bag contract is "parsed value", so a str
    # that is JSON is decoded here defensively.
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            pass
    return {"id": int(ident), "title": title, "payload": payload}
