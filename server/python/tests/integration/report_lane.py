"""One database engine of the api-contract ``report/`` lane: schema, seed, ObjectManager.

The corpus ships a TypeScript-produced schema per engine (``report/schema.<engine>.sql``: the
four base tables and the nine report views). A lane executes it verbatim into an EMPTY
database, seeds the base tables from ``seed.json`` (every key but ``reports``; the keys are
listed parents first), and reads the views through the ObjectManager with the engine's driver.
"""
from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import closing, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pg8000.dbapi as pg8000

from metaobjects.runtime import MySqlDriver, ObjectManager, PostgresDriver, SqliteDriver
from metaobjects.runtime.dialect import Dialect, MYSQL, POSTGRES, SQLITE

from .engines import split_statements
from .generated_report_app import load_runtime_root
from .mysql_container import MySqlInfo
from .mysql_container import connect as mysql_connect
from .postgres_container import PostgresContainer

ENGINES = ("postgres", "sqlite", "mysql")

_DIALECTS: dict[str, Dialect] = {"postgres": POSTGRES, "sqlite": SQLITE, "mysql": MYSQL}


@dataclass
class ReportLane:
    engine: str
    conn: Any
    om: ObjectManager
    #: base tables in seed order (parents first): name -> rows
    base_tables: dict[str, list[dict[str, Any]]]
    #: what the views are expected to return for the full seed
    expected_reports: dict[str, list[dict[str, Any]]]

    def reseed(self, *, empty: bool) -> None:
        """Delete every base row (children first), then insert the seed unless *empty*."""
        d = _DIALECTS[self.engine]
        cur = self.conn.cursor()
        try:
            for table in reversed(list(self.base_tables)):
                cur.execute(f"DELETE FROM {d.quote(table)}")
            if not empty:
                for table, rows in self.base_tables.items():
                    for row in rows:
                        cols = ", ".join(d.quote(c) for c in row)
                        marks = ", ".join(d.placeholder for _ in row)
                        cur.execute(
                            f"INSERT INTO {d.quote(table)} ({cols}) VALUES ({marks})",
                            tuple(row.values()),
                        )
            if self.engine == "postgres":
                # An explicit id does not advance an identity column: continue after the seed
                # (or restart at 1 when the table was left empty), as the other engines do.
                for table, seed_rows in self.base_tables.items():
                    if not seed_rows:
                        # An empty seed (the decimal corpus' ``samples``) restarts at 1 so the
                        # first POST is id 1; only if the table has a generated ``id``.
                        cur.execute(
                            f"SELECT 1 FROM information_schema.columns WHERE table_name = '{table}' "
                            "AND column_name = 'id' AND (is_identity = 'YES' OR column_default LIKE 'nextval%')"
                        )
                        if cur.fetchone() is None:
                            continue
                    elif not _has_id(seed_rows):
                        continue
                    cur.execute(
                        f"SELECT setval(pg_get_serial_sequence('{d.quote(table)}', 'id'), "
                        f"COALESCE((SELECT MAX({d.quote('id')}) FROM {d.quote(table)}), 0) + 1, false)"
                    )
            elif self.engine == "mysql":
                # DELETE leaves AUTO_INCREMENT where it was: restart an empty-seeded table at 1.
                for table, seed_rows in self.base_tables.items():
                    if not seed_rows:
                        cur.execute(f"ALTER TABLE {d.quote(table)} AUTO_INCREMENT = 1")
            self.conn.commit()
        finally:
            cur.close()


def _has_id(rows: list[dict[str, Any]]) -> bool:
    return bool(rows) and "id" in rows[0]


def load_seed(corpus_root: Path) -> tuple[dict[str, list[dict[str, Any]]], dict[str, list[dict[str, Any]]]]:
    parsed = json.loads((corpus_root / "seed.json").read_text())
    reports = parsed.get("reports")
    if not isinstance(reports, dict):
        raise RuntimeError("report seed.json: missing 'reports' object")
    base = {name: rows for name, rows in parsed.items() if name != "reports"}
    return base, reports


def _exec_script(conn: Any, script: str) -> None:
    cur = conn.cursor()
    try:
        for stmt in split_statements(script):
            cur.execute(stmt)
        conn.commit()
    finally:
        cur.close()


@contextmanager
def open_lane(
    engine: str,
    corpus_root: Path,
    *,
    sqlite_path: Path | None = None,
    mysql: MySqlInfo | None = None,
) -> Iterator[ReportLane]:
    """Provision *engine* (a fresh Postgres, the SQLite file *sqlite_path*, or the EMPTY MySQL
    database *mysql*), execute the corpus schema into it, and yield a lane over it."""
    schema = (corpus_root / f"schema.{engine}.sql").read_text()
    base, reports = load_seed(corpus_root)
    root = load_runtime_root(corpus_root)
    if engine == "postgres":
        with PostgresContainer() as pg:
            info = pg.info()
            with closing(pg8000.connect(
                host=info.host, port=info.port, user=info.user,
                password=info.password, database=info.database,
            )) as conn:
                _exec_script(conn, schema)
                yield ReportLane(engine, conn, ObjectManager(root, PostgresDriver(conn)), base, reports)
    elif engine == "sqlite":
        assert sqlite_path is not None
        # check_same_thread=False: the generated sync routes run on the framework's threadpool.
        with closing(sqlite3.connect(str(sqlite_path), check_same_thread=False)) as conn:
            _exec_script(conn, schema)
            yield ReportLane(engine, conn, ObjectManager(root, SqliteDriver(conn)), base, reports)
    elif engine == "mysql":
        assert mysql is not None
        with closing(mysql_connect(mysql)) as conn:
            _exec_script(conn, schema)
            yield ReportLane(engine, conn, ObjectManager(root, MySqlDriver(conn)), base, reports)
    else:
        raise ValueError(f"unknown engine {engine!r}")
