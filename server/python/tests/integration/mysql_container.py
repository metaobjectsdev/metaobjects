"""A throwaway MySQL 8.4 server for the MySQL conformance lanes.

Shells out to the ``docker`` CLI exactly like :mod:`postgres_container`, with the
testcontainers package supplying only Ryuk (see :mod:`reaper`). One server is started for a whole pytest session (see ``conftest.py``); every scenario starts
from an EMPTY schema via :func:`reset_database`, which is what the Java and Kotlin lanes do.

Set ``METAOBJECTS_TEST_MYSQL_URL`` (``mysql://user:password@host:port/database``) to run
against an existing server instead: the tests then OWN that database and drop everything in it.
"""
from __future__ import annotations

import os
import subprocess
import time
import uuid
from contextlib import closing
from dataclasses import dataclass
from typing import Any
from urllib.parse import unquote, urlsplit

from .postgres_container import published_port
from .reaper import reaper_label_args

SHARED_MYSQL_URL_ENV = "METAOBJECTS_TEST_MYSQL_URL"


@dataclass(frozen=True)
class MySqlInfo:
    host: str
    port: int
    database: str
    user: str
    password: str


def connect(info: MySqlInfo, **kwargs: Any) -> Any:
    """A PyMySQL connection to *info*. ``charset`` is utf8mb4 and the session is UTC, which is
    the wall clock the corpus stores in a ``DATETIME``."""
    import pymysql  # local import: PyMySQL lives in the `integration` / `mysql` extras

    return pymysql.connect(
        host=info.host, port=info.port, user=info.user, password=info.password,
        database=info.database, charset="utf8mb4", init_command="SET time_zone = '+00:00'",
        **kwargs,
    )


def reset_database(info: MySqlInfo) -> None:
    """Drop every view and table, leaving the database empty."""
    with closing(connect(info)) as conn, closing(conn.cursor()) as cur:
        cur.execute(
            "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = %s",
            (info.database,),
        )
        objects = list(cur.fetchall())
        cur.execute("SET FOREIGN_KEY_CHECKS = 0")
        for name, kind in objects:
            keyword = "VIEW" if kind == "VIEW" else "TABLE"
            cur.execute(f"DROP {keyword} IF EXISTS `{name}`")
        cur.execute("SET FOREIGN_KEY_CHECKS = 1")
        conn.commit()


class MySqlContainer:
    IMAGE = "mysql:8.4"
    DATABASE = "mo_test"
    USER = "root"
    PASSWORD = "test"

    def __init__(self) -> None:
        shared = os.environ.get(SHARED_MYSQL_URL_ENV)
        if shared:
            parts = urlsplit(shared)
            self._name: str | None = None
            self._info = MySqlInfo(
                host=parts.hostname or "localhost", port=parts.port or 3306,
                database=parts.path.lstrip("/") or self.DATABASE,
                user=unquote(parts.username or self.USER), password=unquote(parts.password or ""),
            )
            return
        self._name = f"metaobjects-mysql-py-{uuid.uuid4().hex[:8]}"
        # Docker assigns the host port at bind time; see the port note in postgres_container.
        try:
            _docker(
                "run", "-d", *reaper_label_args(), "--name", self._name,
                "-e", f"MYSQL_ROOT_PASSWORD={self.PASSWORD}",
                "-e", f"MYSQL_DATABASE={self.DATABASE}",
                # Native AIO reserves ~17k kernel aio-nr slots per server; with the default
                # fs.aio-max-nr (65536) parallel lanes exhaust it and InnoDB dies with EAGAIN
                # at io_setup(). Buffered I/O is plenty for a test database.
                "-p", "127.0.0.1::3306", self.IMAGE, "--innodb-use-native-aio=0",
            )
            port = published_port(self._name, 3306)
            self._info = MySqlInfo("127.0.0.1", port, self.DATABASE, self.USER, self.PASSWORD)
            self._wait_ready()
        except BaseException:
            self._force_remove()
            raise

    def info(self) -> MySqlInfo:
        return self._info

    def stop(self) -> None:
        if self._name is not None:
            self._force_remove()

    def __enter__(self) -> "MySqlContainer":
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop()

    def _force_remove(self) -> None:
        try:
            _docker("rm", "-f", "-v", str(self._name))
        except Exception:  # noqa: BLE001 -- already gone
            pass

    def _state(self) -> str:
        r = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Status}}", str(self._name)],
            capture_output=True, text=True,
        )
        return r.stdout.strip() if r.returncode == 0 else "gone"

    def _logs(self, *args: str) -> str:
        r = subprocess.run(["docker", "logs", *args, str(self._name)], capture_output=True, text=True)
        return (r.stdout + r.stderr).strip() if r.returncode == 0 else "(docker logs unavailable)"

    # MySQL's entrypoint runs a TEMPORARY server to initialise the data directory (listening
    # on "port: 0"), stops it, then starts the real one. Ready needs the real server's log
    # line AND a client connection from the host.
    def _wait_ready(self) -> None:
        timeout_s = int(os.environ.get("MO_MYSQL_READY_TIMEOUT_S", "180"))
        deadline = time.monotonic() + timeout_s
        last_err: Exception | None = None
        while time.monotonic() < deadline:
            state = self._state()
            if state != "running":
                raise RuntimeError(
                    f"mysql container '{self._name}' is '{state}', not running -- it died during "
                    f"startup rather than being slow. docker logs:\n{self._logs('--tail', '40')}"
                )
            logs = self._logs()
            if "ready for connections" in logs and "port: 3306" in logs:
                try:
                    connect(self._info).close()
                    return
                except Exception as e:  # noqa: BLE001 -- the driver may throw anything mid-boot
                    last_err = e
            time.sleep(0.5)
        raise RuntimeError(
            f"mysql container '{self._name}' did not become ready within {timeout_s}s "
            f"(state={self._state()}); last err: {last_err}. docker logs:\n{self._logs('--tail', '40')}"
        )


def _docker(*args: str) -> str:
    r = subprocess.run(["docker", *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise subprocess.CalledProcessError(r.returncode, ["docker", *args], output=r.stdout, stderr=r.stderr)
    return r.stdout.strip()
