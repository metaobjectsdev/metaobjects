"""ObjectManager + the DB-API drivers — minimal query runtime.

Compiles a Filter dict to parameterized SQL and runs it via a DB-API 2 driver. The SQL is
spelled by the driver's :class:`~metaobjects.runtime.dialect.Dialect`: Postgres (here:
``PostgresDriver``, pg8000 / psycopg) double-quotes identifiers and uses ``%s``
placeholders (mixed-case columns like `programId` round-trip through PG); SQLite and MySQL
drivers live in :mod:`metaobjects.runtime.drivers`.

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
import re as _re
import uuid as _uuid
from collections.abc import Iterable, Mapping
from typing import Any, Protocol

from ..meta.meta_root import MetaRoot
from ..meta.core.object.meta_object import MetaObject
from ..meta.core.object.object_constants import OBJECT_SUBTYPE_REPORT
from ..meta.core.reporting.report_read_model import report_read_model
from ..meta.core.field.meta_field import MetaField
from ..meta.core.field import field_constants as fc
from ..naming import (
    DEFAULT_COLUMN_NAMING,
    naming_rules_of,
    removed_naming_source_message,
    resolve_column_name,
)
from ..meta.core.identity import identity_constants as ic
from ..meta.persistence.db import db_constants as dbc
from ..meta.persistence.source.meta_source import MetaSource
from ..source_resolution import resolve_table_name
from .n2m_resolver import (
    N2mDescriptor,
    collect_column_ids,
    collect_symmetric_target_ids,
    resolve_n2m_descriptor,
)
from .dialect import MYSQL, POSTGRES, Dialect
from .tph import TphSubtype, tph_subtype_of
from .validator_runner import ValidationResult, run_validators


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
    @property
    def rowcount(self) -> int: ...
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


class DbApiDriver:
    """Wrap a DB-API 2 connection. Owns no state beyond the connection and its
    :class:`~metaobjects.runtime.dialect.Dialect`.

    Subclasses pick the dialect and the per-column type metadata; everything else (the
    cursor handling, commit-per-write, parameter encoding) is shared. Statements arrive
    already spelled for the dialect (quoting, placeholders), and every bound parameter is
    run through :meth:`Dialect.encode_param` here, so no caller binds an engine-specific
    spelling by hand."""

    dialect: Dialect = POSTGRES

    def __init__(self, conn: Connection) -> None:
        self._conn = conn

    def _bind(self, params: tuple[Any, ...]) -> tuple[Any, ...]:
        return tuple(self.dialect.encode_param(p) for p in params)

    @staticmethod
    def _type_codes(description: Any) -> list[Any]:
        """Per-column SQL type codes beside the names (Postgres: the type OID)."""
        return [d[1] for d in description]

    def _result(self, description: Any, rows: list[Any]) -> SelectResult:
        cols = [d[0] for d in description]
        codes = self._type_codes(description)
        column_oids = {c: codes[i] for i, c in enumerate(cols) if codes[i] is not None}
        return SelectResult([{c: row[i] for i, c in enumerate(cols)} for row in rows], column_oids)

    def select(self, sql: str, params: tuple[Any, ...] = ()) -> SelectResult:
        cur = self._conn.cursor()
        try:
            cur.execute(sql, self._bind(params))
            return self._result(cur.description, list(cur.fetchall()))
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
            cur.execute(sql, self._bind(params))
            description = cur.description
            rows = list(cur.fetchall())[:1]
            self._conn.commit()
            return self._result(description, rows)
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
            cur.execute(sql, self._bind(params))
            description = cur.description
            rows = list(cur.fetchall())[:1]
            self._conn.commit()
            if not rows:
                return None
            return self._result(description, rows)
        finally:
            cur.close()

    def insert_last_id(self, sql: str, params: tuple[Any, ...] = ()) -> Any:
        """Run an INSERT on an engine with no ``RETURNING`` and answer the key the
        engine generated (``lastrowid``; ``0`` / ``None`` when the caller supplied the key).
        Commits on success."""
        cur = self._conn.cursor()
        try:
            cur.execute(sql, self._bind(params))
            last = getattr(cur, "lastrowid", None)
            self._conn.commit()
            return last
        finally:
            cur.close()

    def execute_rowcount(self, sql: str, params: tuple[Any, ...] = ()) -> int:
        """Run a DML statement (DELETE / UPDATE) and return the affected row
        count. Commits on success."""
        cur = self._conn.cursor()
        try:
            cur.execute(sql, self._bind(params))
            count = cur.rowcount
            self._conn.commit()
            return int(count) if count is not None else 0
        finally:
            cur.close()


class PostgresDriver(DbApiDriver):
    """Wrap a pg8000 / psycopg connection (the Postgres dialect)."""

    dialect = POSTGRES


class ObjectManager:
    """Method-based read API. Translates Filter dicts → parameterized SQL."""

    def __init__(
        self,
        root: MetaRoot,
        driver: DbApiDriver,
        column_naming: str | None = None,
    ) -> None:
        if column_naming is not None:
            # ADR-0058 Decision 4 — `ObjectManager(column_naming=...)` was removed in
            # 1.1.0: naming is one project setting now, read from the loaded root
            # (never guessed — the old value may have been right for that adopter's
            # database, and silently dropping it would rename every column).
            raise ValueError(
                removed_naming_source_message("ObjectManager(column_naming=...)", column_naming)
            )
        self._root = root
        self._driver = driver
        #: The SQL dialect of the driver's engine; a driver that declares none (a test
        #: double) is Postgres, the corpus' own engine.
        self._d: Dialect = getattr(driver, "dialect", POSTGRES)
        # How a field with no explicit `@column` becomes a physical column name —
        # ADR-0058: THE one project setting, read from the loaded root
        # (`naming_rules_of`), so codegen's `names` generator and this runtime cannot
        # disagree about what a constant means.
        self._column_naming = naming_rules_of(root).columns
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

    def validate(self, entity_name: str, data: Mapping[str, Any]) -> ValidationResult:
        """Validate ``data`` against ``entity_name``'s metadata — no database access, and
        nothing is raised for invalid data: the failures come back on the result. Mirrors
        the TS ``om.validate()``. The write methods do not call it; validate first when
        the data is untrusted."""
        return run_validators(self._declared_entity(entity_name), data)

    def find_by_id(self, entity_name: str, id_value: Any) -> dict[str, Any] | None:
        self._refuse_report("find_by_id", entity_name)
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
        self._refuse_report("create", entity_name)
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
        self._refuse_report("insert_preserving", entity_name)
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
            # #214: a DERIVED (origin.*) field has no column on the write table — it is
            # view-computed. A read-modify-write round-trip (a client POSTs back the read
            # model, which carries derived fields) must not try to INSERT it; drop it here.
            if f.is_derived():
                continue
            insert_cols.append(_column_of(f, self._column_naming))
            params.append(_coerce_write_value(f, raw))

        # RETURNING the physical column set so the inserted row — including any
        # server-generated PK / default — comes back, then map columns → metadata field
        # names for cross-port row-shape parity. #214: a DERIVED (origin.*) field has no
        # column on the write table (it is computed by the replica view), so it is
        # excluded from RETURNING; the write-through re-read below fetches it via the view.
        returning_fields = [f for f in entity.fields() if not f.is_derived()]
        all_cols = [_column_of(f, self._column_naming) for f in returning_fields]
        col_to_field = {_column_of(f, self._column_naming): f.name for f in returning_fields}

        if insert_cols:
            col_list = ", ".join(self._d.quote(c) for c in insert_cols)
            placeholders = ", ".join(self._d.placeholder for _ in insert_cols)
            sql = f"INSERT INTO {self._d.quote(table)} ({col_list}) VALUES ({placeholders})"
        else:
            sql = f"INSERT INTO {self._d.quote(table)} {self._d.default_values}"
        if self._d.supports_returning:
            sql += f" RETURNING {', '.join(self._d.quote(c) for c in all_cols)}"
            result = self._driver.insert_returning(sql, tuple(params))
        else:
            # No RETURNING (MySQL): insert, then re-read the row by its key -- the key the
            # caller supplied, else the one the engine generated (AUTO_INCREMENT).
            generated = self._driver.insert_last_id(sql, tuple(params))
            pk_field = self._primary_pk_field(entity)
            supplied = data.get(pk_field)
            pk_value = supplied if supplied is not None else generated
            if pk_value is None or (supplied is None and pk_value == 0):
                raise ValueError(
                    f"create('{entity_name}'): the {self._d.name} engine cannot return a "
                    f"generated key other than an AUTO_INCREMENT one, so supply a value for "
                    f"'{pk_field}'"
                )
            written = self._select_by_key(entity, returning_fields, pk_field, pk_value, tph)
            if written is None:
                raise RuntimeError(
                    f"create('{entity_name}'): the inserted row {pk_field}={pk_value!r} "
                    f"could not be read back"
                )
            result = written
        # Surface the RETURNING column OIDs (mapped to metadata field names) so the
        # serialization boundary applies the same SQL-type wire rules as a read — a
        # BIGINT / currency column comes back as a numeric string. Mirrors update().
        self.last_column_oids = self._type_codes(result, col_to_field, returning_fields)
        row = result.rows[0]
        mapped = {col_to_field.get(k, k): v for k, v in row.items()}
        # int-backed enums come back as integers; hand the caller the symbol.
        mapped = _decode_read_row({f.name: f for f in returning_fields}, mapped, self._d)
        # #214: a write-through entity's INSERT RETURNING covers only the table (non-derived)
        # columns; re-read the persisted row through the replica VIEW by PK so the returned row
        # carries the derived origin.* fields (read-your-writes). find_by_id routes to the view.
        if entity.is_write_through():
            reread = self.find_by_id(entity_name, mapped[self._primary_pk_field(entity)])
            if reread is not None:
                return reread
        return mapped

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
        self._refuse_report("update", entity_name)
        entity = self._require_entity(entity_name)
        table = self._table_name(entity)
        pk_field = self._primary_pk_field(entity)
        pk_col = _column_of(entity.find_field(pk_field), self._column_naming)

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
            # #214: a DERIVED (origin.*) field has no column on the write table (view-computed).
            # A read-modify-write round-trip PATCHing back the whole read model must not try to
            # UPDATE it; drop it from the SET list.
            if f.is_derived():
                continue
            set_cols.append(_column_of(f, self._column_naming))
            params.append(_coerce_write_value(f, raw))
        if not set_cols:
            # No columns to set → just read the (scoped) row back by PK (no-op update).
            row = self.find_by_id(entity_name, id_value)
            return self._on_missing_update(entity_name, pk_field, id_value, if_missing) if row is None else row

        # #214: exclude DERIVED (origin.*) fields from RETURNING — they have no column on
        # the write table (computed by the replica view); the write-through re-read below
        # fetches them via the view.
        returning_fields = [f for f in entity.fields() if not f.is_derived()]
        all_cols = [_column_of(f, self._column_naming) for f in returning_fields]
        col_to_field = {_column_of(f, self._column_naming): f.name for f in returning_fields}
        assignments = ", ".join(f"{self._d.quote(c)} = {self._d.placeholder}" for c in set_cols)
        params.append(_coerce_write_value(entity.find_field(pk_field), id_value))
        where = f"{self._d.quote(pk_col)} = {self._d.placeholder}"
        if tph is not None:
            where += f" AND {self._d.quote(_column_of(entity.find_field(tph.field), self._column_naming))} = {self._d.placeholder}"
            params.append(tph.value)
        sql = f"UPDATE {self._d.quote(table)} SET {assignments} WHERE {where}"
        if self._d.supports_returning:
            sql += f" RETURNING {', '.join(self._d.quote(c) for c in all_cols)}"
            result = self._driver.update_returning(sql, tuple(params))
        else:
            # No RETURNING (MySQL): update, then re-read the (TPH-scoped) row by its key. A
            # row that matched but changed nothing still reads back, which a rowcount would
            # report as no match.
            self._driver.execute_rowcount(sql, tuple(params))
            result = self._select_by_key(entity, returning_fields, pk_field, id_value, tph)
        if result is None:
            self.last_column_oids = {}
            return self._on_missing_update(entity_name, pk_field, id_value, if_missing)
        # Surface the RETURNING column OIDs (mapped to metadata field names) so the
        # serialization boundary applies the same SQL-type wire rules as a read —
        # a BIGINT / currency column comes back as a numeric string. Mirrors the
        # find_many bookkeeping.
        self.last_column_oids = self._type_codes(result, col_to_field, returning_fields)
        row = result.rows[0]
        mapped = {col_to_field.get(k, k): v for k, v in row.items()}
        # int-backed enums come back as integers; hand the caller the symbol.
        mapped = _decode_read_row({f.name: f for f in returning_fields}, mapped, self._d)
        # #214: re-read the updated row through the replica VIEW by PK so the returned row
        # carries the derived origin.* fields (write targeted the table, which lacks them).
        if entity.is_write_through():
            reread = self.find_by_id(entity_name, id_value)
            if reread is not None:
                return reread
        return mapped

    def _type_codes(
        self, result: SelectResult, col_to_field: dict[str, str], fields: Iterable[MetaField]
    ) -> dict[str, int]:
        """The per-field SQL type metadata for the serialization boundary. A driver with
        column OIDs (Postgres) supplies them; an engine with none (SQLite, MySQL) reports
        the equivalent for each field's declared subtype."""
        if self._d.synthesizes_type_codes:
            codes = ((f.name, self._d.type_code(f)) for f in fields)
            return {name: code for name, code in codes if code is not None}
        return {col_to_field.get(c, c): oid for c, oid in result.column_oids.items()}

    def _select_by_key(
        self,
        entity: MetaObject,
        fields: list[MetaField],
        pk_field: str,
        key: Any,
        tph: TphSubtype | None,
    ) -> SelectResult | None:
        """Read one row of the WRITE table by its key (TPH-scoped), or ``None``: how an
        engine with no ``RETURNING`` hands back what it just wrote."""
        ph = self._d.placeholder
        cols = [_column_of(f, self._column_naming) for f in fields]
        pk = entity.find_field(pk_field)
        if pk is None:
            raise ValueError(f"Entity '{entity.name}' has no primary key field '{pk_field}'")
        pk_col = _column_of(pk, self._column_naming)
        params: list[Any] = [_coerce_write_value(pk, key)]
        where = f"{self._d.quote(pk_col)} = {ph}"
        if tph is not None:
            where += f" AND {self._d.quote(_column_of(entity.find_field(tph.field), self._column_naming))} = {ph}"
            params.append(tph.value)
        sql = (
            f"SELECT {', '.join(self._d.quote(c) for c in cols)} "
            f"FROM {self._d.quote(self._table_name(entity))} WHERE {where}"
        )
        result = self._driver.select(sql, tuple(params))
        if not result.rows:
            return None
        return SelectResult(result.rows[:1], result.column_oids)

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
        self._refuse_report("delete", entity_name)
        entity = self._require_entity(entity_name)
        table = self._table_name(entity)
        pk_field = self._primary_pk_field(entity)
        pk_col = _column_of(entity.find_field(pk_field), self._column_naming)
        params: list[Any] = [_coerce_write_value(entity.find_field(pk_field), id_value)]
        where = f"{self._d.quote(pk_col)} = {self._d.placeholder}"
        # FR-017 TPH: a subtype delete is scoped to its discriminator (cross-subtype
        # delete matches no row → False, mirroring the per-subtype route's 404).
        tph = tph_subtype_of(entity)
        if tph is not None:
            where += f" AND {self._d.quote(_column_of(entity.find_field(tph.field), self._column_naming))} = {self._d.placeholder}"
            params.append(tph.value)
        sql = f"DELETE FROM {self._d.quote(table)} WHERE {where}"
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
        # #214: reads route to the replica VIEW for a write-through entity (carrying the
        # derived origin.* columns), else the entity's own primary source. All effective
        # fields (incl. derived) are selected — the view exposes them.
        table = self._read_source_name(entity)
        cols = [_column_of(f, self._column_naming) for f in entity.fields()]
        sql = f'SELECT {", ".join(self._d.quote(c) for c in cols)} FROM {self._d.quote(table)}'
        params: list[Any] = []
        # FR-017 TPH: a subtype read is scoped to its discriminator value (a row of
        # a different subtype is invisible); the base entity (no @discriminatorValue)
        # reads polymorphically across the single table.
        filter = self._scope_filter(filter, tph_subtype_of(entity))
        where = _compile_filter(filter, entity, self._column_naming, self._d) if filter else None
        if where is not None:
            sql += " WHERE " + where[0]
            params.extend(where[1])
        if sort:
            order_parts = []
            for field_name, direction in sort:
                f = entity.find_field(field_name)
                col = _column_of(f, self._column_naming) if f is not None else field_name
                d = "DESC" if direction.lower() == "desc" else "ASC"
                order_parts.append(f"{self._d.quote(col)} {d}")
            if order_parts:
                sql += " ORDER BY " + ", ".join(order_parts)
        if limit is not None:
            sql += f" LIMIT {int(limit)}"
        elif offset is not None and self._d.unbounded_limit:
            sql += f" LIMIT {self._d.unbounded_limit}"  # OFFSET needs a LIMIT on this engine
        if offset is not None:
            sql += f" OFFSET {int(offset)}"
        result = self._driver.select(sql, tuple(params))
        # Map raw column → metadata field name for cross-port row-shape parity.
        # Values stay native (ADR-0019); the boundary canonicalizes them.
        col_to_field = {_column_of(f, self._column_naming): f.name for f in entity.fields()}
        self.last_column_oids = self._type_codes(result, col_to_field, entity.fields())
        # int-backed enums come back as integers; hand the caller the symbol.
        fields_by_name = {f.name: f for f in entity.fields()}
        return [
            _decode_read_row(fields_by_name, {col_to_field.get(k, k): v for k, v in row.items()}, self._d)
            for row in result.rows
        ]

    def count(self, entity_name: str, filter: Filter | None = None) -> int:
        entity = self._require_entity(entity_name)
        # #214: count reads through the same source as find_many (the replica view for a
        # write-through entity — a 1:1 replica, so the count is unchanged).
        table = self._read_source_name(entity)
        sql = f"SELECT COUNT(*) FROM {self._d.quote(table)}"
        params: list[Any] = []
        filter = self._scope_filter(filter, tph_subtype_of(entity))  # FR-017 TPH subtype scope
        where = _compile_filter(filter, entity, self._column_naming, self._d) if filter else None
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
        self._refuse_report("relate", entity_name)
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
        select_cols = f"{self._d.quote(source_col)}, {self._d.quote(target_col)}"
        if desc.symmetric:
            sql = (
                f"SELECT {select_cols} FROM {self._d.quote(join_table)} "
                f"WHERE {self._d.quote(source_col)} = {self._d.placeholder} OR {self._d.quote(target_col)} = {self._d.placeholder}"
            )
            params: tuple[Any, ...] = (source_id, source_id)
        else:
            sql = (
                f"SELECT {select_cols} FROM {self._d.quote(join_table)} "
                f"WHERE {self._d.quote(source_col)} = {self._d.placeholder}"
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

    def _declared_entity(self, name: str) -> MetaObject:
        """The object node exactly as loaded (a report is NOT swapped for its read model)."""
        e = self._entity_by_name.get(name)
        if e is None:
            raise KeyError(f"No entity named '{name}' in loaded metadata")
        return e

    def _require_entity(self, name: str) -> MetaObject:
        """The object the runtime reads and writes through. FR-044: a report declares no
        fields (its read shape is derived), so it is read through its detached read model
        (:func:`report_read_model`) — ordinary derived ``field.*`` children plus a copy of
        its own read-only source — and everything downstream (column list, filter and sort
        resolution, read coercion, table resolution) sees an ordinary view-backed object.
        The model is built once per report node and never joins the loaded tree.

        A report with no read-only source of its own has no view (Table A), so there is
        nothing to read: refused as not served rather than read from a table nobody made."""
        e = self._declared_entity(name)
        if e.sub_type != OBJECT_SUBTYPE_REPORT:
            return e
        try:
            model = report_read_model(e, self._root)
        except ValueError as exc:
            raise ValueError(f"Report '{name}' cannot be read: {exc}") from exc
        # ADR-0039: own — the read model is a detached object that extends nothing; its
        # sources are exactly the one copy report_read_model() added, so there is no
        # inherited layer for an own read to drop.
        if not any(isinstance(c, MetaSource) for c in model.own_children()):
            raise ValueError(
                f"Report '{name}' is not served: it declares no read-only source, "
                f"so it has no view to read"
            )
        return model

    def _refuse_report(self, op: str, name: str) -> None:
        """Refuse an operation a report cannot support — get-by-id, relationship
        traversal and every write — on the DECLARED subtype, before anything else is
        looked at (a sourceless report included: it is read-only, not merely unserved)."""
        if self._declared_entity(name).sub_type == OBJECT_SUBTYPE_REPORT:
            raise ValueError(
                f"{op} is not supported on '{name}': a report is read-only and has no identity "
                f"(it is a view over aggregates; only find_many and count read it)"
            )

    def _table_name(self, entity: MetaObject) -> str:
        """The physical relation *entity* lives in.

        Delegates to :func:`~metaobjects.source_resolution.resolve_table_name` —
        THE resolver, shared with codegen and the api-docs builder. It applies the
        FR-016 / ADR-0018 four-step rule to the ``@role: primary`` source, and it
        is RESOLVING (ADR-0039): a FR-017 TPH subtype, which declares no source of
        its own and inherits the discriminator base's single table, resolves to
        that base table, while an entity declaring its own source shadows the
        inherited one and is unchanged.

        Raises :class:`ValueError` when *entity* declares no primary source at all.
        This used to fall back to ``entity.name`` — #248 says participation in
        persistence derives from a DECLARED source, never from the object subtype,
        so that fallback sent every read, write and delete to a relation nothing
        created. Codegen's resolver already returned ``None`` for the shape and the
        M:N descriptor already raised on it; the runtime was the one caller that
        kept its own copy of the predicate and guessed.
        """
        table = resolve_table_name(entity)
        if table is None:
            raise ValueError(
                f'{entity.name}: no primary source (source.rdb) is declared or '
                f"inherited, so this object has no physical relation to read from "
                f"or write to. Declare a source.rdb, or do not persist it through "
                f"the ObjectManager."
            )
        return table

    def _read_source_name(self, entity: MetaObject) -> str:
        """The physical relation READS run against. FR-024 §7 (#214): a write-through
        entity read-view reads through its read-only REPLICA VIEW (which carries the
        derived ``origin.*`` columns), while writes still target the table
        (:meth:`_table_name`). Every other object reads its own primary source (=
        ``_table_name``), so vanilla/projection behavior is unchanged.

        OWN + role-agnostic: the replica view carries ``@role: replica``, so it is found
        by read-only kind among the entity's own sources, not a primary-role accessor."""
        if entity.is_write_through():
            for c in entity.own_children():
                if isinstance(c, MetaSource) and c.is_read_only():
                    pn = c.physical_name()
                    if pn:
                        return pn
        return self._table_name(entity)

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
        return _column_of(f, self._column_naming)

    def primary_key_field(self, entity_name: str) -> str:
        """The single-field primary-key NAME for an entity, from its
        ``identity.primary`` ``@fields``. ``op: roundtrip`` reads the inserted
        row back by this key (composite PKs are not supported by roundtrip)."""
        self._refuse_report("primary_key_field", entity_name)
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


def _compile_filter(
    f: Filter | None,
    entity: MetaObject,
    column_naming: str = DEFAULT_COLUMN_NAMING,
    dialect: Dialect = POSTGRES,
) -> tuple[str, list[Any]] | None:
    if not f:
        return None
    # Top-level `and: [filter, filter, ...]` combinator.
    if "and" in f and isinstance(f["and"], list):
        parts: list[str] = []
        params: list[Any] = []
        for child in f["and"]:
            compiled = _compile_filter(child, entity, column_naming, dialect)
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
        col = _column_of(mf, column_naming) if mf is not None else field_name
        if not isinstance(ops, dict):
            # Shortcut: {field: value} → equality. Encoded like any other bound
            # value (see _op_clause) so an int-backed enum reaches SQL as its int.
            parts.append(f"{dialect.quote(col)} = {dialect.placeholder}")
            params.append(_coerce_filter_value(mf, ops) if mf is not None else ops)
            continue
        for op, value in ops.items():
            sql, p = _op_clause(col, op, value, mf, dialect)
            parts.append(sql)
            params.extend(p)
    if not parts:
        return None
    return " AND ".join(parts), params


def _op_clause(
    col: str, op: str, value: Any, field: MetaField | None = None, dialect: Dialect = POSTGRES
) -> tuple[str, list[Any]]:
    """Translate one operator → SQL + params. Mirrors TS/C#/Java semantics.

    Bound values go through the WRITE codec, exactly as an INSERT's do: the four
    sibling ports all encode on this path (TS through the Drizzle customType, Java
    through GenericSQLDriver.setStatementValue → EnumCodec.write, Kotlin through
    Exposed's toDb, C# through the EF converter). Without it an int-backed enum's
    filter binds the member SYMBOL against an INTEGER column — the filter band
    keeps eq/ne/in for int-backed enums precisely BECAUSE the symbol is supposed
    to encode to its integer before reaching SQL.
    """
    qc = dialect.quote(col)
    ph = dialect.placeholder
    if dialect is MYSQL and field is not None and field.sub_type == "decimal" and op not in ("isNull", "like"):
        # ADR-0019 W2: MySQL compares DECIMAL = 'text' as doubles; a cast operand compares as a
        # decimal, so a 19-digit operand is exact.
        ph = f"CAST({ph} AS DECIMAL(65,30))"
    if field is not None and op != "isNull":
        value = ([_coerce_filter_value(field, v) for v in value]
                 if op == "in" and value else _coerce_filter_value(field, value))
    if op == "eq":     return f"{qc} = {ph}", [value]
    if op == "ne":     return f"{qc} <> {ph}", [value]
    if op == "gt":     return f"{qc} > {ph}", [value]
    if op == "gte":    return f"{qc} >= {ph}", [value]
    if op == "lt":     return f"{qc} < {ph}", [value]
    if op == "lte":    return f"{qc} <= {ph}", [value]
    # `like` is case-SENSITIVE SQL LIKE — verbatim pattern, %/_ wildcards
    # (ADR-0049; the de-blinded filter-like-and-ne fixture gates this). The dialect
    # spells it where the engine's own LIKE is not case-sensitive.
    if op == "like":   return dialect.like_clause(qc, value)
    if op == "isNull":
        wants_null = bool(value) if not isinstance(value, str) else value.lower() == "true"
        return (f"{qc} IS NULL" if wants_null else f"{qc} IS NOT NULL"), []
    if op == "in":
        if not value:
            # Empty IN list — match nothing.
            return dialect.false_predicate(), []
        placeholders = ", ".join(ph for _ in value)
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


_FILTER_INT_SUBTYPES = (fc.FIELD_SUBTYPE_INT, fc.FIELD_SUBTYPE_LONG, fc.FIELD_SUBTYPE_CURRENCY)
_FILTER_FLOAT_SUBTYPES = (fc.FIELD_SUBTYPE_FLOAT, fc.FIELD_SUBTYPE_DOUBLE)


def _coerce_filter_value(field: MetaField, value: Any) -> Any:
    """A filter operand as the native type the column compares against.

    A filter value usually arrives as TEXT (the REST grammar ``filter[f][op]=v`` hands the
    repository the raw URL text). Postgres lets the driver pick the column type for a
    bound string; SQLite and MySQL compare a bound string against a number as TEXT, so
    ``count > '0'`` is wrong there. Numeric and boolean operands are parsed from text by
    the field's declared subtype, then the write codec applies as for any bound value."""
    if isinstance(value, str):
        sub = field.sub_type
        if sub in _FILTER_INT_SUBTYPES:
            value = int(value) if _INT_TEXT.match(value) else value
        elif sub in _FILTER_FLOAT_SUBTYPES:
            try:
                value = float(value)
            except ValueError:
                pass
        elif sub == fc.FIELD_SUBTYPE_BOOLEAN:
            lowered = value.strip().lower()
            if lowered in ("true", "1"):
                value = True
            elif lowered in ("false", "0"):
                value = False
    return _coerce_write_value(field, value)


_INT_TEXT = _re.compile(r"^\s*-?\d+\s*$")


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
    # field.enum carrying @intValueMap: the column is an INTEGER while the native
    # and wire contract stays the member SYMBOL (int-backing is a persistence-layer
    # concern, invisible above this codec), so encode symbol -> declared int here.
    #
    # An unmapped symbol is passed through untouched: membership is the column's
    # CHECK constraint to enforce, and inventing a value here would hide the drift.
    if sub == fc.FIELD_SUBTYPE_ENUM:
        int_map = _int_value_map(field)
        if int_map is not None and value in int_map:
            return int_map[value]

    # Everything else (string / int / long / double / float / boolean / enum)
    # is already the native type pg8000 binds directly.
    return value


def _int_value_map(field: MetaField) -> dict[Any, Any] | None:
    """The declared ``@intValueMap`` (symbol → int), or ``None`` when the enum is
    string-backed.

    ADR-0039 resolving: the map is ``@values``' numeric half — a logical property
    of the enum vocabulary that inherits through ``extends`` — so it is read with
    ``get_meta_attr``, NOT the own-only accessor (contrast ``@dbColumnType`` in
    :func:`_coerce_write_value`, the one field attribute that is deliberately
    own-only). Shared by the write and read halves of the enum codec, mirroring
    the dedicated int-map helper each sibling port's codec keeps (Java
    ``EnumCodec.intValueMap``, Kotlin ``readIntValueMap``, C# ``IntValueMapOf``).
    """
    m = field.get_meta_attr(fc.FIELD_ATTR_INT_VALUE_MAP)
    return m if isinstance(m, dict) else None


def _decode_read_value(field: MetaField, value: Any) -> Any:
    """Decode a stored value back to its authoring form on read.

    Two cases. The inverse of :func:`_coerce_write_value`'s int-backed-enum branch:
    the column holds the member's integer, callers expect the member SYMBOL. And
    ``field.currency``, whose native type is ``int`` minor units: a table column is
    BIGINT and already reads back as an ``int``, but a VIEW column need not be —
    ``SUM`` over BIGINT is Postgres ``numeric``, read back as a ``Decimal``, which a
    FastAPI route then serializes as a JSON STRING. An integral ``Decimal`` is
    decoded to ``int``; a fractional one (an ``avg`` over minor units) has no honest
    ``int`` and is returned as read. Every other field subtype is returned verbatim,
    keeping ADR-0019's "runtime returns native in-process types" contract intact.

    An int with no member RAISES. The database then holds a value the model says
    is impossible — a hand-written INSERT, or a member removed without a
    migration — and neither alternative is honest: returning the raw int hands
    the caller a "member" that is not one (C#, Kotlin and TypeScript type this
    property as a CLOSED enum, where ``7`` is not even representable), and
    returning ``None`` hides the corruption behind a nullable column. Every port
    throws here.
    """
    if value is None:
        return None
    if field.sub_type == fc.FIELD_SUBTYPE_CURRENCY:
        if isinstance(value, _decimal.Decimal) and value == value.to_integral_value():
            return int(value)
        return value
    if field.sub_type != fc.FIELD_SUBTYPE_ENUM:
        return value
    int_map = _int_value_map(field)
    if int_map is None or not isinstance(value, int) or isinstance(value, bool):
        return value
    for symbol, stored in int_map.items():
        if stored == value:
            return symbol
    raise ValueError(
        f"field.enum '{field.name}' read stored value {value} with no member in "
        f"@{fc.FIELD_ATTR_INT_VALUE_MAP} (declared: {int_map}) — the database holds "
        f"a value the model does not describe."
    )


def _decode_read_row(
    fields_by_name: dict[str, MetaField], row: dict[str, Any], dialect: Dialect = POSTGRES
) -> dict[str, Any]:
    """Apply the engine's storage decode, then :func:`_decode_read_value`, to every
    field-keyed value in a mapped row."""
    return {
        k: (
            _decode_read_value(fields_by_name[k], dialect.decode_value(fields_by_name[k], v))
            if k in fields_by_name
            else v
        )
        for k, v in row.items()
    }


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


def _column_of(field: MetaField | None, strategy: str = DEFAULT_COLUMN_NAMING) -> str:
    """Physical column for a field. Module-level shim over the shared
    :func:`metaobjects.naming.resolve_column_name` so the runtime and codegen cannot
    drift on what a column is called."""
    if field is None:
        return ""
    return resolve_column_name(field, strategy)
