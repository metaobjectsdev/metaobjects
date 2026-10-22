"""Hand-rolled reference FastAPI app for the ``Document`` entity from the
``api-contract-conformance/jsonb/`` corpus.

Two contracts are exercised:

* the ``field.string @dbColumnType:jsonb`` open bag (``payload``): a posted JSON
  object round-trips as an object (never a JSON-encoded string);
* Program D — ``field.object @storage:jsonb`` value-object columns
  (``primaryMarker`` required single VO, ``optionalMarker`` nullable single VO,
  ``markers`` nullable array-of-VO over the ``Marker`` value object). VO columns
  are POST-able + PATCH-able with full nested validation and the FR-035 tristate
  (absent → untouched / present-null → clears a nullable column / present-null on
  the required column → 400 / present value → validate then write).

Pared down from ``api_contract_server.py`` (the Author reference) but carrying a
PATCH/PUT handler now that Program D exercises the mutation path. Backend: pg8000
(pure-python DB-API; same driver as ``api_contract_server.py``). Every jsonb
column (open bag + VO) is ``json.dumps``-serialized on write with a ``::jsonb``
cast and auto-decoded by pg8000 on read.
"""
from __future__ import annotations

import json
from contextlib import closing
from typing import Any

import pg8000.dbapi as pg8000
from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse

from metaobjects.codegen.runtime.decimal_wire import check_decimal_range, format_decimal, parse_decimal

from .postgres_container import PostgresInfo


# --- Document field constraints (mirror meta.json; the hand-rolled lane hand-codes
# --- what the generated lane runs through the Pydantic Create/Patch models). ---

# @required wire fields — an absent/null value on POST, or a present-null on PATCH,
# is the cross-port 400 (FR-035 tristate).
_REQUIRED_FIELDS: tuple[str, ...] = ("title", "primaryMarker")
_TITLE_MAX = 200
# Marker { label: string @required @maxLength 40; score: int }.
_MARKER_LABEL_MAX = 40

# Value-object columns, split by cardinality (drives present-value validation).
_VO_SINGLE_FIELDS: tuple[str, ...] = ("primaryMarker", "optionalMarker")
_VO_ARRAY_FIELDS: tuple[str, ...] = ("markers",)
# Measure { ratio: double; samples: double[]; amount: decimal(12, 4) } columns.
_MEASURE_SINGLE = "measure"
_MEASURE_ARRAY = "measures"
_MEASURE_PRECISION, _MEASURE_SCALE = 12, 4

# Wire name → physical (snake_case) column. Every non-title column is jsonb.
_COLUMN: dict[str, str] = {
    "title": "title",
    "payload": "payload",
    "primaryMarker": "primary_marker",
    "optionalMarker": "optional_marker",
    "markers": "markers",
    "measure": "measure",
    "measures": "measures",
    "telemetry": "telemetry",
    "tiers": "tiers",
    "pricing": "pricing",
}
_JSONB_FIELDS: frozenset[str] = frozenset(
    {"payload", "primaryMarker", "optionalMarker", "markers", "measure", "measures", "telemetry", "tiers", "pricing"}
)


class DocumentRepository:
    """Direct-JDBC-equivalent repo against the test Postgres instance."""

    def __init__(self, info: PostgresInfo) -> None:
        self._info = info

    def create_schema(self) -> None:
        self._exec(
            'CREATE TABLE IF NOT EXISTS "documents" ('
            "    id BIGSERIAL PRIMARY KEY,"
            "    title VARCHAR(200) NOT NULL,"
            "    payload JSONB,"
            "    primary_marker JSONB NOT NULL,"
            "    optional_marker JSONB,"
            "    markers JSONB,"
            "    measure JSONB,"
            "    measures JSONB,"
            "    telemetry JSONB,"
            "    tiers JSONB,"
            "    pricing JSONB"
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
                        'INSERT INTO "documents" '
                        "(id, title, payload, primary_marker, optional_marker, markers, measure, measures, telemetry, tiers, pricing) "
                        "VALUES (%s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb)",
                        (
                            int(r["id"]),
                            r["title"],
                            _dump_payload(r.get("payload")),
                            _dump_payload(r.get("primaryMarker")),
                            _dump_payload(r.get("optionalMarker")),
                            _dump_payload(r.get("markers")),
                            _dump_payload(r.get("measure")),
                            _dump_payload(r.get("measures")),
                            _dump_payload(r.get("telemetry")),
                            _dump_payload(r.get("tiers")),
                            _dump_payload(r.get("pricing")),
                        ),
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
                    "SELECT id, title, payload, primary_marker, optional_marker, markers, measure, measures, telemetry, tiers, pricing "
                    'FROM "documents" WHERE id = %s',
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
                    'INSERT INTO "documents" '
                    "(title, payload, primary_marker, optional_marker, markers, measure, measures, telemetry, tiers, pricing) "
                    "VALUES (%s, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb) RETURNING id",
                    (
                        dto.get("title"),
                        _dump_payload(dto.get("payload")),
                        _dump_payload(dto.get("primaryMarker")),
                        _dump_payload(dto.get("optionalMarker")),
                        _dump_payload(dto.get("markers")),
                        _dump_payload(dto.get("measure")),
                        _dump_payload(dto.get("measures")),
                        _dump_payload(dto.get("telemetry")),
                        _dump_payload(dto.get("tiers")),
                        _dump_payload(dto.get("pricing")),
                    ),
                )
                new_id = int(cur.fetchone()[0])
                conn.commit()
            finally:
                cur.close()
        created = self.find_by_id(new_id)
        if created is None:
            raise RuntimeError("create: row vanished between INSERT and SELECT")
        return created

    def update(self, ident: int, dto: dict[str, Any]) -> dict[str, Any] | None:
        """Dynamic SET — only columns whose wire key is PRESENT in the body are
        written (FR-035: absent → untouched). A present-null on a jsonb column
        writes SQL NULL; a present-``[]`` writes an empty jsonb array."""
        set_clauses: list[str] = []
        values: list[Any] = []
        for wire, col in _COLUMN.items():
            if wire not in dto:
                continue
            if wire in _JSONB_FIELDS:
                set_clauses.append(f"{col} = %s::jsonb")
                values.append(_dump_payload(dto[wire]))
            else:
                set_clauses.append(f"{col} = %s")
                values.append(dto[wire])
        if not set_clauses:
            return None
        sql = 'UPDATE "documents" SET ' + ", ".join(set_clauses) + " WHERE id = %s"
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
        # Required columns must be present + non-null (FR-035 / metadata-required).
        for name in _REQUIRED_FIELDS:
            if dto.get(name) is None:
                return _validation_400()
        # Present values validated with the create rules (title @maxLength + nested VO).
        if _title_violation(dto) or _vo_present_violation(dto) or not _canonicalize_measures(dto) or not _canonicalize_tiers(dto):
            return _validation_400()
        return repo.create(dto)

    @app.patch("/api/documents/{document_id}")
    @app.put("/api/documents/{document_id}")
    def update_document(document_id: int, dto: dict[str, Any]) -> Any:
        # FR-035 tristate: an explicit null on a @required column is a 400; a
        # present-null on a nullable column falls through and clears it; an
        # OMITTED required field is untouched (never a 400).
        for name in _REQUIRED_FIELDS:
            if name in dto and dto[name] is None:
                return _validation_400()
        # Validate PRESENT, non-null values (nested VO recurses into each element).
        if _title_violation(dto) or _vo_present_violation(dto) or not _canonicalize_measures(dto) or not _canonicalize_tiers(dto):
            return _validation_400()
        saved = repo.update(document_id, dto)
        if saved is None:
            return JSONResponse(status_code=404, content={"error": "not_found"})
        return saved

    return app


# ---------------------------------------------------------------------------
# Validation helpers — mirror the TS reference (nested VO validates in FULL even
# inside a partial parent update).
# ---------------------------------------------------------------------------


def _validation_400() -> JSONResponse:
    return JSONResponse(status_code=400, content={"error": "validation"})


def _title_violation(dto: dict[str, Any]) -> bool:
    """True iff a present ``title`` exceeds its @maxLength cap."""
    title = dto.get("title")
    return isinstance(title, str) and len(title) > _TITLE_MAX


def _marker_valid(marker: Any) -> bool:
    """A present ``Marker`` is valid iff ``label`` is a non-empty string ≤ 40 chars
    (FR-036 required-string = non-empty; whitespace accepted). ``score`` is a plain
    optional int — never a validation gate."""
    if not isinstance(marker, dict):
        return False
    label = marker.get("label")
    if not isinstance(label, str):
        return False
    return 1 <= len(label) <= _MARKER_LABEL_MAX


def _vo_present_violation(dto: dict[str, Any]) -> bool:
    """True iff any PRESENT, non-null VO value fails Marker validation — for a
    single VO column AND for each element of an array-of-VO column."""
    for name in _VO_SINGLE_FIELDS:
        if name in dto and dto[name] is not None and not _marker_valid(dto[name]):
            return True
    for name in _VO_ARRAY_FIELDS:
        if name in dto and dto[name] is not None:
            value = dto[name]
            if not isinstance(value, list) or any(not _marker_valid(m) for m in value):
                return True
    return False


def _canonical_measure(measure: Any) -> dict[str, Any] | None:
    """A ``Measure`` with its decimal ``amount`` canonicalised (W1 to W3), or ``None`` when the
    value is not a valid Measure. What is stored is the canonical string."""
    if not isinstance(measure, dict):
        return None
    out = dict(measure)
    amount = out.get("amount")
    if amount is not None:
        try:
            d = parse_decimal(amount)
            check_decimal_range(d, _MEASURE_PRECISION, _MEASURE_SCALE)
            out["amount"] = format_decimal(d)
        except (ValueError, ArithmeticError):
            return None
    return out


def _canonicalize_measures(dto: dict[str, Any]) -> bool:
    """Validate and canonicalise the present Measure columns in place; False on a violation."""
    single = dto.get(_MEASURE_SINGLE)
    if _MEASURE_SINGLE in dto and single is not None:
        canon = _canonical_measure(single)
        if canon is None:
            return False
        dto[_MEASURE_SINGLE] = canon
    many = dto.get(_MEASURE_ARRAY)
    if _MEASURE_ARRAY in dto and many is not None:
        if not isinstance(many, list):
            return False
        canon_list = [_canonical_measure(m) for m in many]
        if any(c is None for c in canon_list):
            return False
        dto[_MEASURE_ARRAY] = canon_list
    return True


_TIER_PRECISION, _TIER_SCALE = 12, 4


def _canonical_tier_map(value: Any) -> dict[str, Any] | None:
    """A ``field.map`` of ``Tier`` ({amount: decimal(12, 4)}): the decimal rule applies to EACH
    map value; the keys are arbitrary and never compared with member names. ``None`` on a violation."""
    if not isinstance(value, dict):
        return None
    out: dict[str, Any] = {}
    for key, tier in value.items():
        canon = _canonical_decimal_member(tier, "amount", _TIER_PRECISION, _TIER_SCALE)
        if canon is None:
            return None
        out[key] = canon
    return out


def _canonical_decimal_member(obj: Any, member: str, precision: int, scale: int) -> dict[str, Any] | None:
    if not isinstance(obj, dict):
        return None
    out = dict(obj)
    if out.get(member) is not None:
        try:
            d = parse_decimal(out[member])
            check_decimal_range(d, precision, scale)
            out[member] = format_decimal(d)
        except (ValueError, ArithmeticError):
            return None
    return out


def _canonicalize_tiers(dto: dict[str, Any]) -> bool:
    """Validate and canonicalise Document.tiers (a map of Tier) and Document.pricing (a Pricing
    whose ``tiers`` is a map of Tier) in place; False on a violation."""
    if dto.get("tiers") is not None:
        canon = _canonical_tier_map(dto["tiers"])
        if canon is None:
            return False
        dto["tiers"] = canon
    pricing = dto.get("pricing")
    if pricing is not None:
        if not isinstance(pricing, dict):
            return False
        out = dict(pricing)
        if out.get("tiers") is not None:
            canon = _canonical_tier_map(out["tiers"])
            if canon is None:
                return False
            out["tiers"] = canon
        dto["pricing"] = out
    return True


def _dump_payload(value: Any) -> Any:
    """jsonb bind: a dict/list is ``json.dumps``-serialized for the ``::jsonb``
    cast; ``None`` stays ``None`` (SQL NULL); a pre-serialized string passes
    through."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return json.dumps(value)


def _decode_jsonb(value: Any) -> Any:
    """pg8000 auto-decodes jsonb → native Python object; a driver returning raw
    text is parsed defensively (the contract is 'parsed value')."""
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def _row_to_dict(row: Any) -> dict[str, Any]:
    ident, title, payload, primary_marker, optional_marker, markers, measure, measures, telemetry, tiers, pricing = row
    return {
        "id": int(ident),
        "title": title,
        "payload": _decode_jsonb(payload),
        "primaryMarker": _decode_jsonb(primary_marker),
        "optionalMarker": _decode_jsonb(optional_marker),
        "markers": _decode_jsonb(markers),
        "measure": _decode_jsonb(measure),
        "measures": _decode_jsonb(measures),
        "telemetry": _decode_jsonb(telemetry),
        "tiers": _decode_jsonb(tiers),
        "pricing": _decode_jsonb(pricing),
    }
