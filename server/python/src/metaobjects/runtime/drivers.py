"""Drivers for the engines beyond Postgres: SQLite (stdlib ``sqlite3``) and MySQL (PyMySQL).

Each is a :class:`~metaobjects.runtime.object_manager.DbApiDriver` that names its
:class:`~metaobjects.runtime.dialect.Dialect`; the ObjectManager reads the dialect off the
driver, so ``ObjectManager(root, SqliteDriver(conn))`` is the whole wiring.

* **SQLite** has no per-column type codes (a column's declared type is not on the cursor),
  so the ObjectManager derives the wire discriminator from each field's declared subtype.
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

from typing import Any

from .dialect import MYSQL, SQLITE, Dialect
from .object_manager import DbApiDriver


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
