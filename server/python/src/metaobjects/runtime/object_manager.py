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

import datetime as _dt
import decimal as _decimal
import json as _json
import uuid as _uuid
from collections.abc import Iterable
from typing import Any, Protocol

from ..meta.meta_root import MetaRoot
from ..meta.core.object.meta_object import MetaObject
from ..meta.core.field.meta_field import MetaField
from ..meta.core.field import field_constants as fc
from ..meta.core.identity import identity_constants as ic
from ..meta.persistence.db import db_constants as dbc
from ..meta.persistence.source.meta_source import MetaSource
from ..meta.persistence.source import source_constants as sc
from .n2m_resolver import (
    N2mDescriptor,
    collect_column_ids,
    collect_symmetric_target_ids,
    resolve_n2m_descriptor,
)
from .tph import TphSubtype, tph_subtype_of


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

    def insert_returning(self, sql: str, params: tuple[Any, ...] = ()) -> SelectResult:
        """Run an INSERT ... RETURNING and return a single-row :class:`SelectResult`
        (row + per-column OID type metadata).

        The write path commits on success (each conformance scenario owns a
        fresh container, so autocommit-per-write semantics are fine and keep the
        round-trip read in the same connection visible without a separate
        transaction handshake). The OIDs carry the int4-vs-int8 (BIGINT→string)
        wire discriminator into the serialization boundary, exactly like the read
        path — so an op:create asserting the RETURNING row sees BIGINT as a string.
        """
        cur = self._conn.cursor()
        try:
            cur.execute(sql, params)
            cols = [d[0] for d in cur.description]
            oids = [d[1] for d in cur.description]
            row = cur.fetchone()
            self._conn.commit()
            column_oids = {c: oids[i] for i, c in enumerate(cols)}
            return SelectResult([{c: row[i] for i, c in enumerate(cols)}], column_oids)
        finally:
            cur.close()

    def update_returning(
        self, sql: str, params: tuple[Any, ...] = ()
    ) -> SelectResult | None:
        """Run an UPDATE ... RETURNING; return a single-row :class:`SelectResult`
        (row + per-column OID type metadata), or ``None`` when no row matched.
        Commits on success (same per-write autocommit semantics as
        ``insert_returning``). The OIDs carry the int4-vs-int8 (BIGINT→string)
        wire discriminator into the serialization boundary, exactly like the read
        path — so a BIGINT/currency column updates back as a numeric string."""
        cur = self._conn.cursor()
        try:
            cur.execute(sql, params)
            cols = [d[0] for d in cur.description]
            oids = [d[1] for d in cur.description]
            row = cur.fetchone()
            self._conn.commit()
            if row is None:
                return None
            column_oids = {c: oids[i] for i, c in enumerate(cols)}
            return SelectResult([{c: row[i] for i, c in enumerate(cols)}], column_oids)
        finally:
            cur.close()

    def execute_rowcount(self, sql: str, params: tuple[Any, ...] = ()) -> int:
        """Run a DML statement (DELETE / UPDATE) and return the affected row
        count. Commits on success."""
        cur = self._conn.cursor()
        try:
            cur.execute(sql, params)
            count = cur.rowcount
            self._conn.commit()
            return int(count) if count is not None else 0
        finally:
            cur.close()


class ObjectManager:
    """Method-based read API. Translates Filter dicts → parameterized SQL."""

    def __init__(self, root: MetaRoot, driver: PostgresDriver) -> None:
        self._root = root
        self._driver = driver
        self._entity_by_name: dict[str, MetaObject] = {}
        # ADR-0039 sanctioned own: top-level entity scan on the loader ROOT
        # (metadata.root is never extended, so own == effective) — mirrors the TS
        # object-manager (``this.metadata.ownChildren()``).
        for c in root.own_children():
            if isinstance(c, MetaObject):
                self._entity_by_name.setdefault(c.name, c)
        #: Per-field Postgres type OID from the most recent ``find_*`` query,
        #: keyed by metadata field name. Out-of-band SQL-type metadata for the
        #: serialization boundary (the int4-vs-int8 wire discriminator); the
        #: returned row values themselves stay native (ADR-0019).
        #:
        #: Single-query-scoped: overwritten by each ``find_*`` call, so read it
        #: immediately after the query whose result you are serializing. Not
        #: safe to interleave concurrent queries on one ObjectManager instance
        #: (the row values are unaffected — only this discriminator is racy).
        self.last_column_oids: dict[str, int] = {}

    # --- Public API ----------------------------------------------------------

    def find_by_id(self, entity_name: str, id_value: Any) -> dict[str, Any] | None:
        entity = self._require_entity(entity_name)
        pk_field = self._primary_pk_field(entity)
        rows = self.find_many(entity_name, {pk_field: id_value}, sort=None, limit=1, offset=None)
        return rows[0] if rows else None

    def create(self, entity_name: str, data: dict[str, Any]) -> dict[str, Any]:
        """INSERT a row through the runtime write path, returning the inserted row.

        ``data`` carries field-keyed values in their *native authoring forms*
        (the persistence-conformance ``op: roundtrip`` contract): a decimal /
        uuid / temporal as a string, a ``field.object`` as a dict, currency as an
        integer (minor units). Each value is coerced to the native Python type
        the driver binds to the column's physical type (``Decimal`` / ``uuid.UUID``
        / ``date`` / ``time`` / naive-or-aware ``datetime`` / ``dict``→jsonb), so
        the WRITE codec is exercised end-to-end. Server-defaulted columns the
        caller omits (e.g. a ``gen_random_uuid()`` PK) are left out of the INSERT
        and filled by Postgres; the full row — including the generated PK — is
        returned via ``RETURNING`` so a round-trip read can key off it.

        #203 — ``@autoSet`` stamping: EVERY ``onCreate`` AND ``onUpdate`` temporal
        column is stamped with a single shared ``now()`` (keyed off the column's
        type), OVERRIDING any caller-supplied value — so a fresh row's updated
        timestamp equals its created one. Use :meth:`insert_preserving` for the
        import/restore path that must keep original timestamps.
        """
        entity = self._require_entity(entity_name)
        # #203: stamp every onCreate AND onUpdate column with one shared now() (the
        # caller's value is ignored). No-op for entities that declare no @autoSet field.
        on_create, on_update = _auto_set_fields(entity)
        if on_create or on_update:
            base = _dt.datetime.now(_dt.timezone.utc)
            data = {**data}
            for f in (*on_create, *on_update):
                data[f.name] = _auto_set_stamp(f, base)
        return self._insert_row(entity, entity_name, data)

    def insert_preserving(self, entity_name: str, data: dict[str, Any]) -> dict[str, Any]:
        """#203 escape hatch — INSERT that writes the ``@autoSet`` columns VERBATIM
        from *data*, skipping the ``now()`` stamping :meth:`create` applies.

        For import / restore / replication paths that must persist the ORIGINAL
        ``createdAt`` / ``updatedAt`` timestamps a row carried, not fresh ones.
        Every other column behaves exactly as :meth:`create` (same write codec,
        same TPH discriminator injection, same ``RETURNING`` row). For an entity
        that declares no ``@autoSet`` field this is identical to :meth:`create`.
        """
        entity = self._require_entity(entity_name)
        return self._insert_row(entity, entity_name, data)

    def _insert_row(
        self, entity: MetaObject, entity_name: str, data: dict[str, Any]
    ) -> dict[str, Any]:
        """Shared INSERT core for :meth:`create` / :meth:`insert_preserving` — the
        two differ only in whether *data* was ``@autoSet``-stamped before arriving
        here. Builds the parameterized INSERT (coercing each value via the write
        codec), runs it ``RETURNING`` the full physical column set, and maps the
        row back to metadata field names."""
        table = self._table_name(entity)

        # FR-017 TPH: a subtype create injects its discriminator value (the entity
        # names the subtype; the caller never sets it).
        tph = tph_subtype_of(entity)
        if tph is not None:
            data = {**data, tph.field: tph.value}

        insert_cols: list[str] = []
        params: list[Any] = []
        for field_name, raw in data.items():
            f = entity.find_field(field_name)
            if f is None:
                raise ValueError(
                    f"create('{entity_name}'): no field '{field_name}' in metadata"
                )
            insert_cols.append(_column_of(f))
            params.append(_coerce_write_value(f, raw))

        # Always RETURNING the full physical column set so the inserted row —
        # including any server-generated PK / default — comes back, then map
        # columns → metadata field names for cross-port row-shape parity.
        all_cols = [_column_of(f) for f in entity.fields()]
        col_to_field = {_column_of(f): f.name for f in entity.fields()}

        if insert_cols:
            col_list = ", ".join(_q(c) for c in insert_cols)
            placeholders = ", ".join("%s" for _ in insert_cols)
            sql = (
                f"INSERT INTO {_q(table)} ({col_list}) VALUES ({placeholders}) "
                f"RETURNING {', '.join(_q(c) for c in all_cols)}"
            )
        else:
            sql = (
                f"INSERT INTO {_q(table)} DEFAULT VALUES "
                f"RETURNING {', '.join(_q(c) for c in all_cols)}"
            )
        result = self._driver.insert_returning(sql, tuple(params))
        # Surface the RETURNING column OIDs (mapped to metadata field names) so the
        # serialization boundary applies the same SQL-type wire rules as a read — a
        # BIGINT / currency column comes back as a numeric string. Mirrors update().
        self.last_column_oids = {
            col_to_field.get(c, c): oid for c, oid in result.column_oids.items()
        }
        row = result.rows[0]
        return {col_to_field.get(k, k): v for k, v in row.items()}

    def update(
        self,
        entity_name: str,
        id_value: Any,
        data: dict[str, Any],
        *,
        if_missing: str = "ignore",
    ) -> dict[str, Any] | None:
        """UPDATE a row by primary key through the runtime write path.

        ``data`` carries field-keyed values in the same *native authoring forms*
        as :meth:`create` (a decimal/uuid/temporal as a string, ``field.object``
        as a dict, currency as integer minor units). Each value is run through the
        SAME write codec the INSERT path uses (``_coerce_write_value``) so the
        PATCH path cannot silently skip the type coercion INSERT applies — the
        per-port hazard the ``update-delete-all-types`` corpus gates.

        #203 — ``@autoSet`` stamping: every ``onUpdate`` temporal column is bumped
        to ``now()`` (overriding any caller value), while ``onCreate`` columns are
        stripped and never rewritten — a full-row update carrying a stale
        ``createdAt`` cannot clobber the write-once creation timestamp.

        Returns the updated row (mapped to metadata field names) via ``RETURNING``.
        When no row matched the (TPH-scoped) PK, behavior follows *if_missing*
        (mirrors the TS ``WriteOpts.ifMissing``): ``"ignore"`` (default) → ``None``
        so a REST route renders 404; ``"throw"`` → raise so the persistence DSL's
        ``expect-error`` op is satisfied. The discriminator is immutable, so a TPH
        subtype's patch strips it and the by-id write is scoped to the subtype (a
        cross-subtype id matches no row → the same not-found path).
        """
        entity = self._require_entity(entity_name)
        table = self._table_name(entity)
        pk_field = self._primary_pk_field(entity)
        pk_col = _column_of(entity.find_field(pk_field))

        # #203 — @autoSet: bump every onUpdate column to now(), and NEVER rewrite an
        # onCreate column — strip it even if the caller supplied a (stale) value.
        # Omitting this onCreate-skip is the latent lost-update bug the issue calls
        # out. No-op for entities that declare no @autoSet field.
        on_create, on_update = _auto_set_fields(entity)
        if on_create or on_update:
            base = _dt.datetime.now(_dt.timezone.utc)
            data = {**data}
            for f in on_create:
                data.pop(f.name, None)  # created_at is write-once — never overwritten on update
            for f in on_update:
                data[f.name] = _auto_set_stamp(f, base)

        # FR-017 TPH: the discriminator is immutable — strip it from the patch; the
        # by-id write is subtype-scoped (a row of a different subtype is invisible).
        tph = tph_subtype_of(entity)
        if tph is not None and tph.field in data:
            data = {k: v for k, v in data.items() if k != tph.field}

        set_cols: list[str] = []
        params: list[Any] = []
        for field_name, raw in data.items():
            f = entity.find_field(field_name)
            if f is None:
                raise ValueError(
                    f"update('{entity_name}'): no field '{field_name}' in metadata"
                )
            set_cols.append(_column_of(f))
            params.append(_coerce_write_value(f, raw))
        if not set_cols:
            # No columns to set → just read the (scoped) row back by PK (no-op update).
            row = self.find_by_id(entity_name, id_value)
            return self._on_missing_update(entity_name, pk_field, id_value, if_missing) if row is None else row

        all_cols = [_column_of(f) for f in entity.fields()]
        col_to_field = {_column_of(f): f.name for f in entity.fields()}
        assignments = ", ".join(f"{_q(c)} = %s" for c in set_cols)
        params.append(_coerce_write_value(entity.find_field(pk_field), id_value))
        where = f"{_q(pk_col)} = %s"
        if tph is not None:
            where += f" AND {_q(_column_of(entity.find_field(tph.field)))} = %s"
            params.append(tph.value)
        sql = (
            f"UPDATE {_q(table)} SET {assignments} WHERE {where} "
            f"RETURNING {', '.join(_q(c) for c in all_cols)}"
        )
        result = self._driver.update_returning(sql, tuple(params))
        if result is None:
            self.last_column_oids = {}
            return self._on_missing_update(entity_name, pk_field, id_value, if_missing)
        # Surface the RETURNING column OIDs (mapped to metadata field names) so the
        # serialization boundary applies the same SQL-type wire rules as a read —
        # a BIGINT / currency column comes back as a numeric string. Mirrors the
        # find_many bookkeeping.
        self.last_column_oids = {
            col_to_field.get(c, c): oid for c, oid in result.column_oids.items()
        }
        row = result.rows[0]
        return {col_to_field.get(k, k): v for k, v in row.items()}

    @staticmethod
    def _on_missing_update(
        entity_name: str, pk_field: str, id_value: Any, if_missing: str
    ) -> None:
        """No (TPH-scoped) row matched an update: ``"throw"`` raises (the persistence
        ``expect-error`` contract), ``"ignore"`` returns ``None`` (REST route → 404)."""
        if if_missing == "throw":
            raise KeyError(
                f"update('{entity_name}'): no row with {pk_field}={id_value!r} in scope"
            )
        return None

    def delete(self, entity_name: str, id_value: Any) -> bool:
        """DELETE a row by primary key through the runtime write path.

        Returns ``True`` when a row was deleted, ``False`` when the PK matched
        nothing. Mirrors the TS ``om.delete`` boolean outcome contract.
        """
        entity = self._require_entity(entity_name)
        table = self._table_name(entity)
        pk_field = self._primary_pk_field(entity)
        pk_col = _column_of(entity.find_field(pk_field))
        params: list[Any] = [_coerce_write_value(entity.find_field(pk_field), id_value)]
        where = f"{_q(pk_col)} = %s"
        # FR-017 TPH: a subtype delete is scoped to its discriminator (cross-subtype
        # delete matches no row → False, mirroring the per-subtype route's 404).
        tph = tph_subtype_of(entity)
        if tph is not None:
            where += f" AND {_q(_column_of(entity.find_field(tph.field)))} = %s"
            params.append(tph.value)
        sql = f"DELETE FROM {_q(table)} WHERE {where}"
        return self._driver.execute_rowcount(sql, tuple(params)) > 0

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
        # FR-017 TPH: a subtype read is scoped to its discriminator value (a row of
        # a different subtype is invisible); the base entity (no @discriminatorValue)
        # reads polymorphically across the single table.
        filter = self._scope_filter(filter, tph_subtype_of(entity))
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
        filter = self._scope_filter(filter, tph_subtype_of(entity))  # FR-017 TPH subtype scope
        where = _compile_filter(filter, entity) if filter else None
        if where is not None:
            sql += " WHERE " + where[0]
            params.extend(where[1])
        n = self._driver.scalar(sql, tuple(params))
        return int(n) if n is not None else 0

    def relate(
        self, entity_name: str, record: dict[str, Any], relation_name: str
    ) -> list[dict[str, Any]] | dict[str, Any] | None:
        """Traverse a relationship from a source *record* to its related rows.

        M:N (FR-017) is resolved generically from metadata: derive the junction
        FK fields from the junction's two ``identity.reference`` children, query
        the junction, then load the target rows. Three modes — hetero, directed
        self-join (``@sourceRefField``), symmetric self-join (``@symmetric``) —
        mirror the TS reference resolver. ``record`` is a source-key dict (e.g.
        ``{"id": 1}``); only the source PK is read from it.
        """
        entity = self._require_entity(entity_name)
        desc = resolve_n2m_descriptor(entity, relation_name, self._entity_by_name)
        if desc is None:
            raise ValueError(
                f"Relationship '{relation_name}' on '{entity_name}' is not a "
                f"resolvable M:N relationship (only M:N traversal is supported "
                f"by relate() today)"
            )
        return self._relate_n2m(entity, desc, record)

    def _relate_n2m(
        self, entity: MetaObject, desc: N2mDescriptor, record: dict[str, Any]
    ) -> list[dict[str, Any]]:
        junction = self._require_entity(desc.junction_entity_name)
        target = self._require_entity(desc.target_entity_name)

        # Source PK value from the in-process record (the relate `by` key).
        source_pk_field = self._primary_pk_field(entity)
        source_id = record.get(source_pk_field)
        if source_id is None:
            return []

        # Physical junction columns for the derived FK fields.
        source_col = self._junction_column(junction, desc.source_field)
        target_col = self._junction_column(junction, desc.target_field)

        # Query the junction. Symmetric unions both FK columns; directed/hetero
        # filter only the source side.
        join_table = self._table_name(junction)
        select_cols = f"{_q(source_col)}, {_q(target_col)}"
        if desc.symmetric:
            sql = (
                f"SELECT {select_cols} FROM {_q(join_table)} "
                f"WHERE {_q(source_col)} = %s OR {_q(target_col)} = %s"
            )
            params: tuple[Any, ...] = (source_id, source_id)
        else:
            sql = (
                f"SELECT {select_cols} FROM {_q(join_table)} "
                f"WHERE {_q(source_col)} = %s"
            )
            params = (source_id,)
        join_rows = self._driver.select(sql, params).rows

        # Collect the related (target) ids.
        if desc.symmetric:
            target_ids = collect_symmetric_target_ids(
                join_rows, source_col, target_col, {source_id}
            )
        else:
            target_ids = collect_column_ids(join_rows, target_col)
        if not target_ids:
            return []

        # Load the target rows by PK. Reuse find_many so the row shape (metadata
        # field names) + last_column_oids match every other read path.
        target_pk_field = self._primary_pk_field(target)
        return self.find_many(
            desc.target_entity_name, {target_pk_field: {"in": target_ids}}
        )

    # --- Helpers -------------------------------------------------------------

    def _require_entity(self, name: str) -> MetaObject:
        e = self._entity_by_name.get(name)
        if e is None:
            raise KeyError(f"No entity named '{name}' in loaded metadata")
        return e

    def _table_name(self, entity: MetaObject) -> str:
        # FR-016 / ADR-0018 — physical_name implements the four-step rule
        # (kind-matching alias → legacy @table → source.name → entity-name
        # fallback), so this just delegates to the primary source.
        #
        # ADR-0039 — RESOLVING (children()) in a SINGLE pass, mirroring the TS
        # ``resolveTableName``. Effective children (own + inherited via the super
        # chain) mean a FR-017 TPH SUBTYPE — which declares no source of its own
        # and inherits the discriminator base's single table — resolves to that
        # base table; for an entity declaring its own source, own shadows inherited
        # so the result is unchanged. (The prior own-first pass was the redundant
        # "works-by-accident" pattern this ADR eliminates.)
        for c in entity.children():
            if isinstance(c, MetaSource) and c.role() == sc.SOURCE_ROLE_PRIMARY:
                pn = c.physical_name()
                if pn:
                    return pn
        return entity.name

    @staticmethod
    def _scope_filter(filter: Filter | None, tph: TphSubtype | None) -> Filter | None:
        """AND the TPH discriminator predicate into a filter (subtype-scoped reads).
        Non-TPH (``tph is None``) returns the filter unchanged."""
        if tph is None:
            return filter
        disc: Filter = {tph.field: tph.value}  # equality shortcut
        if not filter:
            return disc
        return {"and": [filter, disc]}

    def _junction_column(self, junction: MetaObject, field_name: str) -> str:
        """Physical column for a junction FK field (metadata field name → column)."""
        f = junction.find_field(field_name)
        if f is None:
            raise ValueError(
                f"Junction '{junction.name}' has no field '{field_name}'"
            )
        return _column_of(f)

    def primary_key_field(self, entity_name: str) -> str:
        """The single-field primary-key NAME for an entity, from its
        ``identity.primary`` ``@fields``. ``op: roundtrip`` reads the inserted
        row back by this key (composite PKs are not supported by roundtrip)."""
        return self._primary_pk_field(self._require_entity(entity_name))

    def _primary_pk_field(self, entity: MetaObject) -> str:
        pi = entity.primary_identity()
        if pi is None:
            raise ValueError(f"Entity '{entity.name}' has no primary identity")
        raw = pi.get_meta_attr(ic.IDENTITY_ATTR_FIELDS)  # ADR-0039 resolving: identity @fields may be inherited
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


# ----------------------------------------------------------------------------
# Write codec — authoring form → native Python type the driver binds (ADR-0019
# write side). pg8000 maps Decimal→numeric, uuid.UUID→uuid, naive datetime→
# timestamp, aware datetime→timestamptz, date→date, time→time, dict→jsonb. We
# only need to turn the corpus' authoring *strings* into those native types; the
# driver does the rest. Mirrors the TS runtime write coercer (type-coercer.ts):
# jsonb objects + native binding per subtype, everything else passes through.
# ----------------------------------------------------------------------------


def _field_is_array(field: MetaField) -> bool:
    """Effective array-ness (ADR-0039 resolving): the native ``is_array`` flag OR
    the ``@isArray`` attr, resolved through the ``extends`` super chain so a concrete
    field inheriting array-ness from an abstract parent is honored at write time."""
    return field.resolved_is_array()


def _coerce_write_value(field: MetaField, value: Any) -> Any:
    if value is None:
        return None
    sub = field.sub_type
    # ADR-0039 own-only: @dbColumnType is a physical column-type override, never
    # inherited via extends (the one deliberately own-only attribute).
    col_type = field.attr(dbc.FIELD_ATTR_DB_COLUMN_TYPE)

    # decimal / currency: a decimal authored as a string → Decimal (exact; never
    # via float). currency is integer minor units — already an int, pass through.
    if sub == fc.FIELD_SUBTYPE_DECIMAL:
        return value if isinstance(value, _decimal.Decimal) else _decimal.Decimal(str(value))

    # uuid (logical field.uuid, or a string field pinned to a uuid column):
    # string → uuid.UUID so the driver binds the native uuid type. PG stores it
    # lowercase-canonically regardless of input case.
    #
    # For isArray=true (native uuid[] column, Phase 1): coerce each element in the
    # list. pg8000 binds a Python list[uuid.UUID] to a uuid[] column natively.
    # field.string isArray=true (text[] column) passes through — pg8000 binds
    # list[str] to text[] natively without element conversion.
    if sub == fc.FIELD_SUBTYPE_UUID or col_type == dbc.DB_COLUMN_TYPE_UUID:
        if _field_is_array(field) and isinstance(value, list):
            return [v if isinstance(v, _uuid.UUID) else _uuid.UUID(str(v)) for v in value]
        return value if isinstance(value, _uuid.UUID) else _uuid.UUID(str(value))

    # temporal: parse the authoring string to the native type, with tz-awareness
    # driven by the field so the driver binds the correct physical type. ADR-0036
    # Wave 2: field.timestamp is instant / tz-aware BY DEFAULT (→ timestamptz); the
    # rare naive wall-clock case opts out with @localTime:true (→ plain timestamp).
    if sub == fc.FIELD_SUBTYPE_DATE:
        return value if isinstance(value, _dt.date) else _dt.date.fromisoformat(str(value))
    if sub == fc.FIELD_SUBTYPE_TIME:
        return value if isinstance(value, _dt.time) else _dt.time.fromisoformat(str(value))
    if sub == fc.FIELD_SUBTYPE_TIMESTAMP:
        if isinstance(value, _dt.datetime):
            return value
        is_tz = field.get_meta_attr(dbc.FIELD_ATTR_LOCAL_TIME) is not True  # ADR-0039 resolving: @localTime may be inherited
        return _parse_datetime(str(value), tz_aware=is_tz)

    # field.object / field.map stored as a single jsonb column: serialize to a
    # JSON text string so pg8000 sends it as jsonb text (PG assignment-casts text
    # → jsonb). pg8000 binds a native *dict* to jsonb natively, but a native
    # *list* (array-of-VO, isArray:true) it adapts as a Postgres ARRAY literal
    # `{...,...}` which the JSONB column rejects with 22P02 'invalid input syntax
    # for type json' — so we cannot rely on driver magic for the list form.
    # Serializing both shapes to a JSON string is the explicit codec every other
    # port has (Java/Gson, C#/System.Text.Json, TS/JSON.stringify, Kotlin/Jackson)
    # and handles dict (single VO), list (array-of-VO), and [] uniformly.
    #
    # Scope: only jsonb-storage field.object/field.map. A *flattened* field.object
    # is expanded to separate scalar columns (never reaches here as the object
    # node) and must not be touched; a field.string pinned to a jsonb column via
    # @dbColumnType already carries a string value and is left alone above.
    if sub in (fc.FIELD_SUBTYPE_OBJECT, fc.FIELD_SUBTYPE_MAP):
        storage = field.get_meta_attr(fc.FIELD_ATTR_STORAGE)  # ADR-0039 resolving
        if storage != "flattened":  # None / "jsonb" / "subdocument" → single jsonb column
            return _json.dumps(value)
    # Everything else (string / int / long / double / float / boolean / enum)
    # is already the native type pg8000 binds directly.
    return value


# ----------------------------------------------------------------------------
# #203 — @autoSet CRUD stamping. A ``field.timestamp`` (or any temporal field)
# marked ``@autoSet: onCreate|onUpdate`` declares "the runtime owns this
# timestamp, the caller does not." create() stamps every onCreate AND onUpdate
# column; update() bumps onUpdate and NEVER rewrites onCreate (the lost-update
# guard); insert_preserving() writes them verbatim. The stamp is keyed off the
# COLUMN's temporal type (generalizes past ``datetime`` to date/time), matching
# the TS Zod-transform contract (server owns the value; a fresh row's updated
# timestamp equals its created one).
# ----------------------------------------------------------------------------

_AUTO_SET_TEMPORAL_SUBTYPES = (
    fc.FIELD_SUBTYPE_TIMESTAMP,
    fc.FIELD_SUBTYPE_DATE,
    fc.FIELD_SUBTYPE_TIME,
)


def _auto_set_fields(entity: MetaObject) -> tuple[list[MetaField], list[MetaField]]:
    """The entity's ``@autoSet`` temporal fields split into ``(onCreate, onUpdate)``.

    Reads the RESOLVING ``@autoSet`` (ADR-0039) so a field inherited from an
    abstract base — the common ``BaseEntity.createdAt/updatedAt`` pattern — is
    honored. A non-temporal field is skipped (``@autoSet`` is a temporal-only
    marker). Both lists are empty for an entity that declares no ``@autoSet``
    field, so the write path stays byte-identical for those entities."""
    on_create: list[MetaField] = []
    on_update: list[MetaField] = []
    for f in entity.fields():
        if f.sub_type not in _AUTO_SET_TEMPORAL_SUBTYPES:
            continue
        mode = f.get_meta_attr(fc.FIELD_ATTR_AUTO_SET)  # ADR-0039 resolving: may be inherited via extends
        if mode == fc.AUTO_SET_ON_CREATE:
            on_create.append(f)
        elif mode == fc.AUTO_SET_ON_UPDATE:
            on_update.append(f)
    return on_create, on_update


def _auto_set_stamp(field: MetaField, base: _dt.datetime) -> Any:
    """The native ``now()`` value for an ``@autoSet`` *field*, derived from the
    single shared *base* instant so every column stamped in one operation is
    equal (a fresh row's created == updated). Keyed off the COLUMN's temporal
    type: ``field.date`` → ``date``; ``field.time`` → ``time``; ``field.timestamp``
    → a tz-aware ``datetime`` (the instant default) unless ``@localTime`` opts into
    a naive wall-clock value (matching :func:`_coerce_write_value`)."""
    sub = field.sub_type
    if sub == fc.FIELD_SUBTYPE_DATE:
        return base.date()
    if sub == fc.FIELD_SUBTYPE_TIME:
        return base.time()
    # field.timestamp: instant / tz-aware by default; @localTime → naive wall clock.
    is_tz = field.get_meta_attr(dbc.FIELD_ATTR_LOCAL_TIME) is not True  # ADR-0039 resolving
    return base if is_tz else base.replace(tzinfo=None)


def _parse_datetime(text: str, *, tz_aware: bool) -> _dt.datetime:
    """Parse an ISO-8601 timestamp authoring string to a native datetime.

    A trailing ``Z`` (Zulu/UTC) is normalized to ``+00:00`` for ``fromisoformat``.
    For a TIMESTAMPTZ column we keep the resulting datetime tz-aware (defaulting
    an offset-less string to UTC); for a plain TIMESTAMP column we strip any
    offset to a naive wall-clock value so the driver binds ``timestamp`` (not
    ``timestamptz``).
    """
    iso = text[:-1] + "+00:00" if text.endswith("Z") else text
    dt = _dt.datetime.fromisoformat(iso)
    if tz_aware:
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_dt.timezone.utc)
        return dt
    # Naive wall clock: drop any offset without shifting (the wire form already
    # carried the intended wall-clock components).
    return dt.replace(tzinfo=None)


def _column_of(field: MetaField | None) -> str:
    if field is None:
        return ""
    col = field.get_meta_attr(fc.FIELD_ATTR_COLUMN)  # ADR-0039 resolving: @column may be inherited
    return col if isinstance(col, str) and col else field.name


def _q(ident: str) -> str:
    if '"' in ident:
        raise ValueError(f"unsafe identifier: {ident}")
    return f'"{ident}"'

