"""The DB-API drivers: a connection plus the engine's :class:`~metaobjects.runtime.dialect.Dialect`.

:class:`DbApiDriver` is the base; :class:`PostgresDriver` (pg8000 / psycopg),
:class:`SqliteDriver` (stdlib ``sqlite3``) and :class:`MySqlDriver` (PyMySQL) name their
dialect. :class:`~metaobjects.runtime.object_manager_db.ObjectManagerDb` reads the dialect off
the driver, so ``ObjectManagerDb(root, SqliteDriver(conn))`` is the whole wiring.

Per ADR-0019 (runtime return-type contract) the query path returns **native, in-process
Python types** — pg8000's own `int` / `Decimal` / `datetime` / `date` / `time` /
`uuid.UUID` / `dict` / `list`. Canonicalization to the cross-port wire form is a
serialization/boundary concern, applied by the persistence runner (see
``tests/integration/normalization.py``), never baked into this runtime query path.

The one piece of SQL-type information the boundary cannot recover from a native Python value
is the int4-vs-int8 distinction (pg8000 returns plain ``int`` for both INTEGER and BIGINT, and
a BIGINT aggregate over an INTEGER column is genuinely indistinguishable by value). Other
ports get this from their driver's native typing. To keep the same discriminator available at
the Python boundary each query result carries the per-column OID beside the rows
(:class:`SelectResult`) — out-of-band type metadata, not a mutation of the native row values.

**Transactions.** A write commits on its own unless it runs inside :meth:`DbApiDriver.transaction`,
which holds every statement in it open on the connection and commits once when the outermost
block ends, or rolls all of it back when the block raises. A block inside a block joins it.

* **SQLite** has no per-column type codes (a column's declared type is not on the cursor),
  so the manager derives the wire discriminator from each field's declared subtype.
  ``RETURNING`` needs SQLite >= 3.35; on an older library the write path inserts and then
  re-reads the row by key, as it does for MySQL.
* **MySQL** has no ``RETURNING`` at all; the write path re-reads the row by key (the
  AUTO_INCREMENT key from ``lastrowid``, or the one the caller supplied). Open the PyMySQL
  connection with ``charset="utf8mb4"``; a connection left on a UTC session
  (``init_command="SET time_zone = '+00:00'"``) reads a ``TIMESTAMP`` as UTC.

``sqlite3`` and PyMySQL are imported by the caller, who owns the connection; this module
imports neither.
"""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, Protocol

from ..codegen.runtime.duration_wire import parse_postgres_interval
from .dialect import MYSQL, POSTGRES, SQLITE, Dialect


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
    def rollback(self) -> None: ...
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
        self._depth = 0  # transaction() blocks currently open

    @property
    def in_transaction(self) -> bool:
        """Whether a :meth:`transaction` block is open: a write then does not commit."""
        return self._depth > 0

    def _commit_write(self) -> None:
        """Commit one write, unless it is held by an open :meth:`transaction`."""
        if self._depth == 0:
            self._conn.commit()

    @contextmanager
    def transaction(self) -> Iterator[None]:
        """Hold every statement run inside the block in one transaction on the connection.

        The outermost block commits once when it ends and rolls everything back when it
        raises (the exception then propagates). A block opened inside another joins it:
        there is no savepoint, so an exception that leaves an inner block unwinds through
        the outer one and rolls the whole transaction back, unless the caller catches it
        between the two (the work done so far is then still held, and commits with the outer
        block). A caller that needs a failure to undo only part of the work uses a
        savepoint of its own on the connection."""
        self._depth += 1
        try:
            yield
        except BaseException:
            self._depth -= 1
            if self._depth == 0:
                self._conn.rollback()
            raise
        else:
            self._depth -= 1
            if self._depth == 0:
                self._conn.commit()

    def _cursor(self) -> Any:
        """A cursor for one statement (a driver may set it up for its engine)."""
        return self._conn.cursor()

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
        cur = self._cursor()
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
        cur = self._cursor()
        try:
            cur.execute(sql, self._bind(params))
            description = cur.description
            rows = list(cur.fetchall())[:1]
            self._commit_write()
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
        cur = self._cursor()
        try:
            cur.execute(sql, self._bind(params))
            description = cur.description
            rows = list(cur.fetchall())[:1]
            self._commit_write()
            if not rows:
                return None
            return self._result(description, rows)
        finally:
            cur.close()

    def insert_last_id(self, sql: str, params: tuple[Any, ...] = ()) -> Any:
        """Run an INSERT on an engine with no ``RETURNING`` and answer the key the
        engine generated (``lastrowid``; ``0`` / ``None`` when the caller supplied the key).
        Commits on success."""
        cur = self._cursor()
        try:
            cur.execute(sql, self._bind(params))
            last = getattr(cur, "lastrowid", None)
            self._commit_write()
            return last
        finally:
            cur.close()

    def execute_rowcount(self, sql: str, params: tuple[Any, ...] = ()) -> int:
        """Run a DML statement (DELETE / UPDATE) and return the affected row
        count. Commits on success."""
        cur = self._cursor()
        try:
            cur.execute(sql, self._bind(params))
            count = cur.rowcount
            self._commit_write()
            return int(count) if count is not None else 0
        finally:
            cur.close()


class PostgresDriver(DbApiDriver):
    """Wrap a pg8000 / psycopg connection (the Postgres dialect).

    An ``interval`` is read exactly, and one with a year or month part is never turned into a
    ``timedelta`` (a month has no fixed length, so a ``field.duration`` refuses it):

    * **pg8000** gets an exact ``interval`` / ``interval[]`` reader registered on the connection
      (pg8000 has no per-cursor adapters). pg8000 1.31 drops the sign of a negative time part's
      minutes and seconds (``-00:01:30`` reads as ``+90 s``, ``-01:30:00`` as ``-30 min``). The
      reader takes the default-``IntervalStyle`` text exactly (:func:`parse_postgres_interval`)
      and hands anything else to pg8000's own reader, so an interval with a year or month part
      is still the ``PGInterval`` pg8000 makes of it, and every other interval reads as before.
    * **psycopg** (3, and psycopg2) turns a month into 30 days and a year into 365. The reader
      is registered on each cursor this driver opens, never on the connection: it reads the
      text exactly and hands an interval it cannot read as a fixed span back as its text, which
      a ``field.duration`` refuses."""

    dialect = POSTGRES

    def __init__(self, conn: Connection) -> None:
        super().__init__(conn)
        _register_pg8000_interval_reader(conn)

    def _cursor(self) -> Any:
        cur = self._conn.cursor()
        _register_psycopg_interval_reader(cur)
        return cur


def _interval_or_text(text: str) -> Any:
    """The default-style text of an interval as a ``timedelta``, or the text itself when it is
    not one this reads exactly (a year or month part, another ``IntervalStyle``): a
    ``field.duration`` read refuses that text rather than guessing."""
    try:
        return parse_postgres_interval(text)
    except ValueError:
        return text


def _register_pg8000_interval_reader(conn: Any) -> None:
    """Register the exact ``interval`` reader on a pg8000 connection; any other is untouched."""
    register = getattr(conn, "register_in_adapter", None)
    if not callable(register) or not type(conn).__module__.startswith("pg8000"):
        return
    from pg8000 import converters as _pgc  # type: ignore[import-untyped]  # only with a pg8000 connection

    pg8000_interval_in = _pgc.interval_in

    def interval_in(text: str) -> Any:
        value = _interval_or_text(text)
        # Not read here: pg8000's own reading (a PGInterval for a year or month part).
        return pg8000_interval_in(text) if isinstance(value, str) else value

    register(_pgc.INTERVAL, interval_in)
    register(_pgc.INTERVAL_ARRAY, _pgc._array_in(interval_in))


#: The psycopg 3 text loader for ``interval``, made on first use (psycopg is optional).
_PSYCOPG_INTERVAL_LOADER: Any = None


def _register_psycopg_interval_reader(cur: Any) -> None:
    """Register the exact ``interval`` reader on a psycopg 3 or psycopg2 cursor."""
    module = type(cur).__module__
    if module.startswith("psycopg2"):
        import psycopg2.extensions as _ext  # type: ignore[import-untyped]  # only with a psycopg2 cursor

        interval = _ext.new_type(
            (1186,), "METAOBJECTS_INTERVAL", lambda v, _c: None if v is None else _interval_or_text(v)
        )
        _ext.register_type(interval, cur)
        _ext.register_type(_ext.new_array_type((1187,), "METAOBJECTS_INTERVAL_ARRAY", interval), cur)
        return
    adapters = getattr(cur, "adapters", None)
    if adapters is None or not module.startswith("psycopg"):
        return
    global _PSYCOPG_INTERVAL_LOADER
    if _PSYCOPG_INTERVAL_LOADER is None:
        from psycopg.adapt import Loader  # type: ignore[import-not-found, unused-ignore]  # only with psycopg 3

        class _IntervalLoader(Loader):  # type: ignore[misc, unused-ignore]
            def load(self, data: Any) -> Any:
                return _interval_or_text(bytes(data).decode("ascii"))

        _PSYCOPG_INTERVAL_LOADER = _IntervalLoader
    adapters.register_loader("interval", _PSYCOPG_INTERVAL_LOADER)


class SqliteDriver(DbApiDriver):
    """A ``sqlite3`` connection (qmark parameters, double-quoted identifiers)."""

    dialect: Dialect = SQLITE

    @staticmethod
    def _type_codes(description: Any) -> list[Any]:
        return [None for _ in description]


class MySqlDriver(DbApiDriver):
    """A PyMySQL connection (``%s`` parameters, backtick identifiers)."""

    dialect: Dialect = MYSQL

    @staticmethod
    def _type_codes(description: Any) -> list[Any]:
        return [None for _ in description]
