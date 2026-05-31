"""ObjectManager + PostgresDriver — minimal query runtime.

Compiles a Filter dict to parameterized SQL and runs it via a pg-style
driver. Identifiers are double-quoted throughout (mixed-case columns like
`programId` round-trip through PG); placeholders are pg8000 / psycopg-style
``%s``.

Per ADR-0019 (runtime return-type contract) the query path returns **native,
in-process Python types** — pg8000's own `int` / `Decimal` / `datetime` /
`date` / `time` / `uuid.UUID` / `dict` / `list`. Canonicalization to the
cross-port wire form is a *serialization/boundary* concern, applied by the
persistence runner (see ``tests/integration/normalization.py``), never baked
into this runtime query path.

The one piece of SQL-type information the boundary cannot recover from a native
Python value is the int4-vs-int8 distinction (pg8000 returns plain ``int`` for
both INTEGER and BIGINT, and a BIGINT aggregate over an INTEGER column — e.g.
``count``/``sum`` → BIGINT vs ``min``/``max`` → INTEGER on the projection views —
is genuinely indistinguishable by value). Other ports get this for free from
their driver's native typing (Java JDBC ``Long`` vs ``Integer``; node-postgres
BIGINT-as-string vs INTEGER-as-number). To keep the same discriminator available
at the Python boundary we expose the per-column OID alongside each query — as
out-of-band type metadata, not by mutating the native row values — so the runner
can apply the BIGINT→string wire rule by SQL type, exactly like the other ports.
"""
from __future__ import annotations

from collections.abc import Iterable
from typing import Any, Protocol

from ..meta.meta_root import MetaRoot
from ..meta.core.object.meta_object import MetaObject
from ..meta.core.field.meta_field import MetaField
from ..meta.core.field import field_constants as fc
from ..meta.core.identity import identity_constants as ic
from ..meta.persistence.source.meta_source import MetaSource
from ..meta.persistence.source import source_constants as sc


# Filter shape:
#   {"field": "value"}                    → equality shortcut
#   {"field": {"eq": v, "gt": v, ...}}    → typed ops on a field
#   {"and": [filter, filter, ...]}        → top-level combinator
Filter = dict[str, Any]


class Cursor(Protocol):
    def execute(self, sql: str, params: tuple[Any, ...] = ...) -> Any: ...
    def fetchall(self) -> list[Any]: ...
    @property
    def description(self) -> Any: ...
    def close(self) -> None: ...


class Connection(Protocol):
    def cursor(self) -> Cursor: ...
    def commit(self) -> None: ...
    def close(self) -> None: ...


class SelectResult:
    """A native-typed result set plus the per-column OID type metadata.

    ``rows`` carry pg8000's native Python values verbatim (ADR-0019 — the runtime
    returns native types, never wire-strings). ``column_oids`` maps each selected
    column name to its Postgres type OID so the serialization boundary can apply
    the int4-vs-int8 (and any other SQL-type-driven) wire rule without inspecting
    the value — type metadata travels beside the data, not inside it.
    """

    __slots__ = ("rows", "column_oids")

    def __init__(self, rows: list[dict[str, Any]], column_oids: dict[str, int]) -> None:
        self.rows = rows
        self.column_oids = column_oids


class PostgresDriver:
    """Wrap a DB-API 2 connection (pg8000 / psycopg). Owns no state itself."""

    def __init__(self, conn: Connection) -> None:
        self._conn = conn

    def select(self, sql: str, params: tuple[Any, ...] = ()) -> SelectResult:
        cur = self._conn.cursor()
        try:
            cur.execute(sql, params)
            cols = [d[0] for d in cur.description]
            oids = [d[1] for d in cur.description]
            column_oids = {c: oids[i] for i, c in enumerate(cols)}
            rows = [
                {c: v for c, v in zip(cols, row)}
                for row in cur.fetchall()
            ]
            return SelectResult(rows, column_oids)
        finally:
            cur.close()

    def scalar(self, sql: str, params: tuple[Any, ...] = ()) -> Any:
        result = self.select(sql, params)
        if not result.rows:
            return None
        return next(iter(result.rows[0].values()))


class ObjectManager:
    """Method-based read API. Translates Filter dicts → parameterized SQL."""

    def __init__(self, root: MetaRoot, driver: PostgresDriver) -> None:
        self._root = root
        self._driver = driver
        self._entity_by_name: dict[str, MetaObject] = {}
        for c in root.own_children():
            if isinstance(c, MetaObject):
                self._entity_by_name.setdefault(c.name, c)
        #: Per-field Postgres type OID from the most recent ``find_*`` query,
        #: keyed by metadata field name. Out-of-band SQL-type metadata for the
        #: serialization boundary (the int4-vs-int8 wire discriminator); the
        #: returned row values themselves stay native (ADR-0019).
        self.last_column_oids: dict[str, int] = {}

    # --- Public API ----------------------------------------------------------

    def find_by_id(self, entity_name: str, id_value: Any) -> dict[str, Any] | None:
        entity = self._require_entity(entity_name)
        pk_field = self._primary_pk_field(entity)
        rows = self.find_many(entity_name, {pk_field: id_value}, sort=None, limit=1, offset=None)
        return rows[0] if rows else None

    def find_many(
        self,
        entity_name: str,
        filter: Filter | None = None,
        *,
        sort: Iterable[tuple[str, str]] | None = None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> list[dict[str, Any]]:
        entity = self._require_entity(entity_name)
        table = self._table_name(entity)
        cols = [_column_of(f) for f in entity.fields()]
        sql = f'SELECT {", ".join(_q(c) for c in cols)} FROM {_q(table)}'
        params: list[Any] = []
        where = _compile_filter(filter, entity) if filter else None
        if where is not None:
            sql += " WHERE " + where[0]
            params.extend(where[1])
        if sort:
            order_parts = []
            for field_name, direction in sort:
                f = entity.find_field(field_name)
                col = _column_of(f) if f is not None else field_name
                d = "DESC" if direction.lower() == "desc" else "ASC"
                order_parts.append(f"{_q(col)} {d}")
            if order_parts:
                sql += " ORDER BY " + ", ".join(order_parts)
        if limit is not None:
            sql += f" LIMIT {int(limit)}"
        if offset is not None:
            sql += f" OFFSET {int(offset)}"
        result = self._driver.select(sql, tuple(params))
        # Map raw column → metadata field name for cross-port row-shape parity.
        # Values stay native (ADR-0019); the boundary canonicalizes them.
        col_to_field = {_column_of(f): f.name for f in entity.fields()}
        self.last_column_oids = {
            col_to_field.get(c, c): oid for c, oid in result.column_oids.items()
        }
        return [
            {col_to_field.get(k, k): v for k, v in row.items()} for row in result.rows
        ]

    def count(self, entity_name: str, filter: Filter | None = None) -> int:
        entity = self._require_entity(entity_name)
        table = self._table_name(entity)
        sql = f"SELECT COUNT(*) FROM {_q(table)}"
        params: list[Any] = []
        where = _compile_filter(filter, entity) if filter else None
        if where is not None:
            sql += " WHERE " + where[0]
            params.extend(where[1])
        n = self._driver.scalar(sql, tuple(params))
        return int(n) if n is not None else 0

    # --- Helpers -------------------------------------------------------------

    def _require_entity(self, name: str) -> MetaObject:
        e = self._entity_by_name.get(name)
        if e is None:
            raise KeyError(f"No entity named '{name}' in loaded metadata")
        return e

    def _table_name(self, entity: MetaObject) -> str:
        for c in entity.own_children():
            if isinstance(c, MetaSource) and c.role() == sc.SOURCE_ROLE_PRIMARY:
                tn = c.table_name()
                if tn:
                    return tn
        return entity.name

    def _primary_pk_field(self, entity: MetaObject) -> str:
        pi = entity.primary_identity()
        if pi is None:
            raise ValueError(f"Entity '{entity.name}' has no primary identity")
        raw = pi.attr(ic.IDENTITY_ATTR_FIELDS)
        if isinstance(raw, str):
            return raw
        if isinstance(raw, (list, tuple)) and raw:
            return str(raw[0])
        raise ValueError(f"Entity '{entity.name}' primary identity has no fields")


# ----------------------------------------------------------------------------
# Filter compiler — Filter dict → (WHERE clause SQL, params tuple)
# ----------------------------------------------------------------------------


def _compile_filter(f: Filter | None, entity: MetaObject) -> tuple[str, list[Any]] | None:
    if not f:
        return None
    # Top-level `and: [filter, filter, ...]` combinator.
    if "and" in f and isinstance(f["and"], list):
        parts: list[str] = []
        params: list[Any] = []
        for child in f["and"]:
            compiled = _compile_filter(child, entity)
            if compiled is None:
                continue
            parts.append("(" + compiled[0] + ")")
            params.extend(compiled[1])
        if not parts:
            return None
        return " AND ".join(parts), params

    parts = []
    params = []
    for field_name, ops in f.items():
        mf = entity.find_field(field_name)
        col = _column_of(mf) if mf is not None else field_name
        if not isinstance(ops, dict):
            # Shortcut: {field: value} → equality
            parts.append(f"{_q(col)} = %s")
            params.append(ops)
            continue
        for op, value in ops.items():
            sql, p = _op_clause(col, op, value)
            parts.append(sql)
            params.extend(p)
    if not parts:
        return None
    return " AND ".join(parts), params


def _op_clause(col: str, op: str, value: Any) -> tuple[str, list[Any]]:
    """Translate one operator → SQL + params. Mirrors TS/C#/Java semantics."""
    qc = _q(col)
    if op == "eq":     return f"{qc} = %s", [value]
    if op == "ne":     return f"{qc} <> %s", [value]
    if op == "gt":     return f"{qc} > %s", [value]
    if op == "gte":    return f"{qc} >= %s", [value]
    if op == "lt":     return f"{qc} < %s", [value]
    if op == "lte":    return f"{qc} <= %s", [value]
    if op == "like":   return f"{qc} LIKE %s", [value]
    if op == "isNull":
        wants_null = bool(value) if not isinstance(value, str) else value.lower() == "true"
        return (f"{qc} IS NULL" if wants_null else f"{qc} IS NOT NULL"), []
    if op == "in":
        if not value:
            # Empty IN list — match nothing.
            return "FALSE", []
        placeholders = ", ".join("%s" for _ in value)
        return f"{qc} IN ({placeholders})", list(value)
    raise ValueError(f"Unsupported filter op '{op}' on column '{col}'")


def _column_of(field: MetaField | None) -> str:
    if field is None:
        return ""
    col = field.attr(fc.FIELD_ATTR_COLUMN)
    return col if isinstance(col, str) and col else field.name


def _q(ident: str) -> str:
    if '"' in ident:
        raise ValueError(f"unsafe identifier: {ident}")
    return f'"{ident}"'

