"""ObjectManager + PostgresDriver — minimal query runtime.

Compiles a Filter dict to parameterized SQL and runs it via a pg-style
driver. Identifiers are double-quoted throughout (mixed-case columns like
`programId` round-trip through PG); placeholders are pg8000 / psycopg-style
``%s``.
"""
from __future__ import annotations

import decimal
from collections.abc import Iterable
from typing import Any, Protocol


# pg8000 / psycopg type oids we coerce to string at extraction so the cross-port
# normalization contract (BIGINT → string, NUMERIC → canonical decimal string)
# is honored without leaking SQL-type awareness into the comparison layer.
_PG_OID_BIGINT = 20
_PG_OID_NUMERIC = 1700

from ..meta.meta_root import MetaRoot
from ..meta.core.object.meta_object import MetaObject
from ..meta.core.field.meta_field import MetaField
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


class PostgresDriver:
    """Wrap a DB-API 2 connection (pg8000 / psycopg). Owns no state itself."""

    def __init__(self, conn: Connection) -> None:
        self._conn = conn

    def select(self, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        cur = self._conn.cursor()
        try:
            cur.execute(sql, params)
            cols = [d[0] for d in cur.description]
            oids = [d[1] for d in cur.description]
            return [
                {c: _coerce_for_contract(v, oids[i]) for i, (c, v) in enumerate(zip(cols, row))}
                for row in cur.fetchall()
            ]
        finally:
            cur.close()

    def scalar(self, sql: str, params: tuple[Any, ...] = ()) -> Any:
        rows = self.select(sql, params)
        if not rows:
            return None
        first_row = rows[0]
        return next(iter(first_row.values()))


class ObjectManager:
    """Method-based read API. Translates Filter dicts → parameterized SQL."""

    def __init__(self, root: MetaRoot, driver: PostgresDriver) -> None:
        self._root = root
        self._driver = driver
        self._entity_by_name: dict[str, MetaObject] = {}
        for c in root.own_children():
            if isinstance(c, MetaObject):
                self._entity_by_name.setdefault(c.name, c)

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
        rows = self._driver.select(sql, tuple(params))
        # Map raw column → metadata field name for cross-port row-shape parity.
        col_to_field = {_column_of(f): f.name for f in entity.fields()}
        return [{col_to_field.get(k, k): v for k, v in row.items()} for row in rows]

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
        raw = pi.attr("fields")
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
    col = field.attr("column")
    return col if isinstance(col, str) and col else field.name


def _q(ident: str) -> str:
    if '"' in ident:
        raise ValueError(f"unsafe identifier: {ident}")
    return f'"{ident}"'


def _coerce_for_contract(value: Any, oid: int) -> Any:
    if value is None:
        return None
    if oid == _PG_OID_BIGINT and isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    if oid == _PG_OID_NUMERIC and isinstance(value, decimal.Decimal):
        s = format(value.normalize(), "f")
        if "." in s:
            s = s.rstrip("0").rstrip(".")
        return s
    return value
