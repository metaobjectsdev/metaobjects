"""ObjectManagerDb — the DB-API implementation of :class:`~metaobjects.runtime.object_manager.ObjectManager`.

Compiles a Filter dict to parameterized SQL and runs it through a DB-API 2 driver
(:mod:`metaobjects.runtime.drivers`). The SQL is spelled by the driver's
:class:`~metaobjects.runtime.dialect.Dialect`: Postgres (``PostgresDriver``, pg8000 /
psycopg) double-quotes identifiers and uses ``%s`` placeholders (mixed-case columns like
`programId` round-trip through PG); SQLite and MySQL have their own drivers. Value
conversion (the write and read codecs) lives in :mod:`metaobjects.runtime.values`.

Per ADR-0019 the query path returns native, in-process Python types; see
:mod:`metaobjects.runtime.drivers` for the out-of-band column type metadata
(``last_column_oids``) the serialization boundary reads.
"""
from __future__ import annotations

from collections.abc import Iterable
from contextlib import AbstractContextManager
from typing import Any

from ..meta.meta_root import MetaRoot
from ..meta.core.object.meta_object import MetaObject
from ..meta.core.field.meta_field import MetaField
from ..naming import DEFAULT_COLUMN_NAMING, removed_naming_source_message
from ..meta.persistence.source.meta_source import MetaSource
from ..source_resolution import primary_rdb_source, resolve_table_name
from .n2m_resolver import (
    N2mDescriptor,
    collect_column_ids,
    collect_symmetric_target_ids,
    resolve_n2m_descriptor,
)
from .dialect import MYSQL, POSTGRES, Dialect
from .drivers import DbApiDriver, SelectResult
from .object_manager import Filter, ObjectManager
from .tph import TphSubtype, tph_subtype_of
from .values import (
    coerce_filter_value,
    coerce_key_value,
    coerce_write_value,
    column_of,
    decode_read_row,
    read_fields,
)


class ObjectManagerDb(ObjectManager):
    """The runtime persistence layer over a DB-API 2 driver. Translates Filter dicts →
    parameterized SQL; see :class:`~metaobjects.runtime.object_manager.ObjectManager` for the
    contract."""

    def __init__(
        self,
        root: MetaRoot,
        driver: DbApiDriver,
        column_naming: str | None = None,
    ) -> None:
        if column_naming is not None:
            # ADR-0058 Decision 4 — `ObjectManagerDb(column_naming=...)` was removed in
            # 1.1.0 (as `ObjectManager(column_naming=...)`): naming is one project setting
            # now, read from the loaded root (never guessed — the old value may have been
            # right for that adopter's database, and silently dropping it would rename every
            # column).
            raise ValueError(
                removed_naming_source_message("ObjectManagerDb(column_naming=...)", column_naming)
            )
        super().__init__(root)
        self._driver = driver
        #: The SQL dialect of the driver's engine; a driver that declares none (a test
        #: double) is Postgres, the corpus' own engine.
        self._d: Dialect = getattr(driver, "dialect", POSTGRES)

    def transaction(self) -> AbstractContextManager[None]:
        """Hold the writes made inside the ``with`` block in one transaction on the driver's
        connection (see :meth:`~metaobjects.runtime.drivers.DbApiDriver.transaction`): they
        commit together when the outermost block ends and roll back together when it raises.
        Reads inside the block see the block's own writes."""
        return self._driver.transaction()

    # --- Writes (the base class stamps, notifies and refuses reports; these run the SQL) ---

    def _insert_row(
        self, entity: MetaObject, entity_name: str, data: dict[str, Any]
    ) -> dict[str, Any]:
        """INSERT core behind :meth:`create` / :meth:`insert_preserving` — the
        two differ only in whether *data* was ``@autoSet``-stamped before arriving
        here. Builds the parameterized INSERT (coercing each value via the write
        codec), runs it ``RETURNING`` the full physical column set, and maps the
        row back to metadata field names."""

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
            insert_cols.append(column_of(f, self._column_naming))
            params.append(coerce_write_value(f, raw))

        # RETURNING the physical column set so the inserted row — including any
        # server-generated PK / default — comes back, then map columns → metadata field
        # names for cross-port row-shape parity. #214: a DERIVED (origin.*) field has no
        # column on the write table (it is computed by the replica view), so it is
        # excluded from RETURNING; the write-through re-read below fetches it via the view.
        returning_fields = [f for f in entity.fields() if not f.is_derived()]
        all_cols = [column_of(f, self._column_naming) for f in returning_fields]
        col_to_field = {column_of(f, self._column_naming): f.name for f in returning_fields}

        if insert_cols:
            col_list = ", ".join(self._d.quote(c) for c in insert_cols)
            placeholders = ", ".join(self._d.placeholder for _ in insert_cols)
            sql = f"INSERT INTO {self._relation(entity)} ({col_list}) VALUES ({placeholders})"
        else:
            sql = f"INSERT INTO {self._relation(entity)} {self._d.default_values}"
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
        mapped = decode_read_row({f.name: f for f in returning_fields}, mapped, self._d)
        # #214: a write-through entity's INSERT RETURNING covers only the table (non-derived)
        # columns; re-read the persisted row through the replica VIEW by PK so the returned row
        # carries the derived origin.* fields (read-your-writes). find_by_id routes to the view.
        if entity.is_write_through():
            reread = self.find_by_id(entity_name, mapped[self._primary_pk_field(entity)])
            if reread is not None:
                return reread
        return mapped

    def _update_row(
        self,
        entity: MetaObject,
        entity_name: str,
        id_value: Any,
        data: dict[str, Any],
        if_missing: str,
    ) -> dict[str, Any] | None:
        """UPDATE core behind :meth:`update`: the base class has already refused a report
        and stamped the ``@autoSet`` columns. ``data`` is run through the SAME write codec
        the INSERT path uses (``coerce_write_value``) so the PATCH path cannot silently skip
        the type coercion INSERT applies — the per-port hazard the ``update-delete-all-types``
        corpus gates. Returns the updated row via ``RETURNING``; with no match the answer is
        decided by *if_missing*."""
        pk_field = self._primary_pk_field(entity)
        pk_col = column_of(entity.find_field(pk_field), self._column_naming)

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
            set_cols.append(column_of(f, self._column_naming))
            params.append(coerce_write_value(f, raw))
        if not set_cols:
            # No columns to set → just read the (scoped) row back by PK (no-op update).
            row = self.find_by_id(entity_name, id_value)
            return self._on_missing_update(entity_name, pk_field, id_value, if_missing) if row is None else row

        # #214: exclude DERIVED (origin.*) fields from RETURNING — they have no column on
        # the write table (computed by the replica view); the write-through re-read below
        # fetches them via the view.
        returning_fields = [f for f in entity.fields() if not f.is_derived()]
        all_cols = [column_of(f, self._column_naming) for f in returning_fields]
        col_to_field = {column_of(f, self._column_naming): f.name for f in returning_fields}
        assignments = ", ".join(f"{self._d.quote(c)} = {self._d.placeholder}" for c in set_cols)
        params.append(coerce_key_value(entity.find_field(pk_field), id_value))
        where = f"{self._d.quote(pk_col)} = {self._d.placeholder}"
        if tph is not None:
            where += f" AND {self._d.quote(column_of(entity.find_field(tph.field), self._column_naming))} = {self._d.placeholder}"
            params.append(tph.value)
        sql = f"UPDATE {self._relation(entity)} SET {assignments} WHERE {where}"
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
        mapped = decode_read_row({f.name: f for f in returning_fields}, mapped, self._d)
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
        cols = [column_of(f, self._column_naming) for f in fields]
        pk = entity.find_field(pk_field)
        if pk is None:
            raise ValueError(f"Entity '{entity.name}' has no primary key field '{pk_field}'")
        pk_col = column_of(pk, self._column_naming)
        params: list[Any] = [coerce_key_value(pk, key)]
        where = f"{self._d.quote(pk_col)} = {ph}"
        if tph is not None:
            where += f" AND {self._d.quote(column_of(entity.find_field(tph.field), self._column_naming))} = {ph}"
            params.append(tph.value)
        sql = (
            f"SELECT {', '.join(self._d.quote(c) for c in cols)} "
            f"FROM {self._relation(entity)} WHERE {where}"
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

    def _delete_row(self, entity: MetaObject, entity_name: str, id_value: Any) -> bool:
        """DELETE core behind :meth:`delete`: ``True`` when a row was deleted, ``False`` when
        the (TPH-scoped) key matched nothing."""
        pk_field = self._primary_pk_field(entity)
        pk_col = column_of(entity.find_field(pk_field), self._column_naming)
        params: list[Any] = [coerce_key_value(entity.find_field(pk_field), id_value)]
        where = f"{self._d.quote(pk_col)} = {self._d.placeholder}"
        # FR-017 TPH: a subtype delete is scoped to its discriminator (cross-subtype
        # delete matches no row → False, mirroring the per-subtype route's 404).
        tph = tph_subtype_of(entity)
        if tph is not None:
            where += f" AND {self._d.quote(column_of(entity.find_field(tph.field), self._column_naming))} = {self._d.placeholder}"
            params.append(tph.value)
        sql = f"DELETE FROM {self._relation(entity)} WHERE {where}"
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
        # fields (incl. derived) are selected — the view exposes them. An entity with no read
        # view reads its table, which stores no derived field, so those are left out.
        fields = read_fields(entity)
        cols = [column_of(f, self._column_naming) for f in fields]
        sql = f'SELECT {", ".join(self._d.quote(c) for c in cols)} FROM {self._read_relation(entity)}'
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
                col = column_of(f, self._column_naming) if f is not None else field_name
                order_parts.append(self._d.order_term(self._d.quote(col), direction.lower() == "desc"))
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
        col_to_field = {column_of(f, self._column_naming): f.name for f in fields}
        self.last_column_oids = self._type_codes(result, col_to_field, fields)
        # int-backed enums come back as integers; hand the caller the symbol.
        fields_by_name = {f.name: f for f in fields}
        return [
            decode_read_row(fields_by_name, {col_to_field.get(k, k): v for k, v in row.items()}, self._d)
            for row in result.rows
        ]

    def count(self, entity_name: str, filter: Filter | None = None) -> int:
        entity = self._require_entity(entity_name)
        # #214: count reads through the same source as find_many (the replica view for a
        # write-through entity — a 1:1 replica, so the count is unchanged).
        sql = f"SELECT COUNT(*) FROM {self._read_relation(entity)}"
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
        select_cols = f"{self._d.quote(source_col)}, {self._d.quote(target_col)}"
        if desc.symmetric:
            sql = (
                f"SELECT {select_cols} FROM {self._relation(junction)} "
                f"WHERE {self._d.quote(source_col)} = {self._d.placeholder} OR {self._d.quote(target_col)} = {self._d.placeholder}"
            )
            params: tuple[Any, ...] = (source_id, source_id)
        else:
            sql = (
                f"SELECT {select_cols} FROM {self._relation(junction)} "
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

    # --- Helpers ---------------------------------------------------------------

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

    def _qualified(self, name: str, schema: str | None) -> str:
        """*name* quoted, qualified by its source's ``@schema`` where the engine has schemas.
        ``meta migrate`` creates a relation declared with ``@schema: sales`` as
        ``"sales"."<name>"``; a bare name would resolve through ``search_path`` to another
        relation, or none. SQLite has no schemas, so its names stay bare."""
        quoted = self._d.quote(name)
        return f"{self._d.quote(schema)}.{quoted}" if schema and self._d.qualifies_schemas else quoted

    def _relation(self, entity: MetaObject) -> str:
        """The relation WRITES (and by-id reads) target, quoted and schema-qualified."""
        src = primary_rdb_source(entity)
        return self._qualified(self._table_name(entity), src.schema() if src is not None else None)

    def _read_relation(self, entity: MetaObject) -> str:
        """The relation list and count READS run against (:meth:`_read_source_name`), quoted
        and qualified by the schema of the source it names."""
        if entity.is_write_through():
            for c in entity.own_children():
                if isinstance(c, MetaSource) and c.is_read_only() and c.physical_name():
                    return self._qualified(c.physical_name(), c.schema())
        return self._relation(entity)

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
        return column_of(f, self._column_naming)


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
        col = column_of(mf, column_naming) if mf is not None else field_name
        if not isinstance(ops, dict):
            # Shortcut: {field: value} → equality. Encoded like any other bound
            # value (see _op_clause) so an int-backed enum reaches SQL as its int.
            parts.append(f"{dialect.quote(col)} = {dialect.placeholder}")
            params.append(coerce_filter_value(mf, ops) if mf is not None else ops)
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
        value = ([coerce_filter_value(field, v) for v in value]
                 if op == "in" and value else coerce_filter_value(field, value))
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
