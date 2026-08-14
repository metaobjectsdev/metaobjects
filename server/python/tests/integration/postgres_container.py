"""Obtain a fresh, isolated Postgres database per scenario.

Two modes, mirroring the TS/Java/Kotlin/C# integration suites:

  1. Shared sidecar (CI): if ``METAOBJECTS_TEST_PG_URL`` is set, connect to that
     already-running Postgres and CREATE a uniquely-named database per instance
     (dropping it on stop). No container boot / image pull on the hot path — the
     point of the shared ``services: postgres`` CI sidecar. Each scenario still
     gets a pristine empty database, so isolation is identical to the per-
     container path.
  2. Per-container (local dev): with no env var, ``docker run`` a fresh container,
     exactly as before. Avoids the python-testcontainers package + its docker API
     negotiation churn (the same kind of mismatch testcontainers-java hits
     against Docker Engine 29+).
"""
from __future__ import annotations

import os
import socket
import subprocess
import time
import uuid
from contextlib import closing
from dataclasses import dataclass
from urllib.parse import urlsplit

# Env var naming the shared CI Postgres sidecar (admin URL). Unset = per-container.
SHARED_PG_URL_ENV = "METAOBJECTS_TEST_PG_URL"


@dataclass(frozen=True)
class PostgresInfo:
    """Connection details for a running container."""
    host: str
    port: int
    database: str
    user: str
    password: str


class PostgresContainer:
    """Context manager around ``docker run`` for a per-scenario Postgres."""

    IMAGE = "postgres:16-alpine"

    #: Fresh-port retries before giving up -- see the port-race note in __init__.
    START_ATTEMPTS = 3
    USER = "postgres"
    PASSWORD = "test"
    DATABASE = "postgres"

    def __init__(self) -> None:
        shared = os.environ.get(SHARED_PG_URL_ENV)
        if shared:
            self._shared = True
            self._name = None
            self._db_on_shared(shared)
            return

        self._shared = False
        self._admin_url = None
        self._name = f"metaobjects-test-{uuid.uuid4().hex[:8]}"
        # PORT RACE. _pick_free_port() closes its probe socket and hands the number to
        # docker, which binds it LATER -- a check-then-act gap. Alone it never bites;
        # under a full CI run several ports start containers at once and two can be
        # handed the same number. The loser's container is created and then dies, and a
        # readiness probe that only asks `docker exec` cannot tell that from a slow
        # boot. Retry on a FRESH port.
        #
        # Deliberately NOT `--rm`: an auto-removed container takes its logs with it, so
        # the one artefact explaining the failure vanishes exactly when it is needed.
        # close() force-removes, so nothing leaks.
        last_failure: Exception | None = None
        for _attempt in range(self.START_ATTEMPTS):
            self._port = _pick_free_port()
            self._info = PostgresInfo(
                host="localhost", port=self._port, database=self.DATABASE,
                user=self.USER, password=self.PASSWORD,
            )
            try:
                _docker(
                    "run", "-d",
                    "--name", self._name,
                    "-e", f"POSTGRES_PASSWORD={self.PASSWORD}",
                    "-p", f"{self._port}:5432",
                    self.IMAGE,
                )
            except Exception as e:  # noqa: BLE001 — docker refused the bind; retry on a new port
                last_failure = e
                self._force_remove()
                continue
            try:
                self._wait_ready()
                return
            except Exception as e:  # noqa: BLE001 — died on startup; retry on a new port
                last_failure = e
                self._force_remove()
        raise RuntimeError(
            f"postgres container '{self._name}' failed to start in "
            f"{self.START_ATTEMPTS} attempts; last err: {last_failure}"
        )

    # -- Shared-sidecar mode -------------------------------------------------
    # CREATE a fresh, uniquely-named database on the already-running Postgres
    # named by the admin URL; a dedicated database per scenario preserves the
    # per-container path's "pristine empty DB" isolation.
    def _db_on_shared(self, admin_url: str) -> None:
        import pg8000.dbapi  # local import — pg8000 lives in the `integration` extra

        parts = urlsplit(admin_url)
        self._admin_url = admin_url
        db_name = f"mo_test_{uuid.uuid4().hex}"
        admin_db = parts.path.lstrip("/") or "postgres"
        conn = pg8000.dbapi.connect(
            host=parts.hostname, port=parts.port or 5432,
            user=parts.username, password=parts.password, database=admin_db,
        )
        try:
            conn.autocommit = True  # CREATE DATABASE cannot run in a transaction
            cur = conn.cursor()
            cur.execute(f'CREATE DATABASE "{db_name}"')  # generated name — no user input
        finally:
            conn.close()
        self._info = PostgresInfo(
            host=parts.hostname, port=parts.port or 5432, database=db_name,
            user=parts.username, password=parts.password,
        )

    def info(self) -> PostgresInfo:
        return self._info

    def stop(self) -> None:
        if self._shared:
            import pg8000.dbapi

            parts = urlsplit(self._admin_url)
            admin_db = parts.path.lstrip("/") or "postgres"
            try:
                conn = pg8000.dbapi.connect(
                    host=parts.hostname, port=parts.port or 5432,
                    user=parts.username, password=parts.password, database=admin_db,
                )
                conn.autocommit = True
                cur = conn.cursor()
                cur.execute(
                    f'DROP DATABASE IF EXISTS "{self._info.database}" WITH (FORCE)'
                )
                conn.close()
            except Exception:  # noqa: BLE001 — best-effort cleanup
                pass
            return
        try:
            _docker("rm", "-f", self._name)
        except subprocess.CalledProcessError:
            pass  # container already gone — fine

    def __enter__(self) -> "PostgresContainer":
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop()

    # -----------------------------------------------------------------------
    # Readiness — wait for both pg_isready inside the container AND a real
    # client connection from the host (Postgres' first-boot entrypoint restarts
    # the server, so pg_isready briefly succeeds before the real boot
    # finishes; mirrors the TS/Java two-phase wait).
    # -----------------------------------------------------------------------

    # READINESS WINDOW. 30s was too tight: under a FULL local-CI run several ports
    # spin their own Postgres concurrently, and a container that is merely slow to
    # boot produces a red gate indistinguishable from a real failure -- it fires
    # BEFORE any test logic. Raising the bound costs nothing when the container is
    # ready quickly (the loop polls every 250ms and returns immediately) and only
    # changes how long the pathological case takes to give up.
    def _force_remove(self) -> None:
        """Best-effort teardown between start attempts."""
        try:
            _docker("rm", "-f", self._name)
        except Exception:  # noqa: BLE001 — already gone
            pass

    def _inspect_state(self) -> str:
        """The container's docker state, or 'gone' when it cannot be determined."""
        r = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Status}}", self._name],
            capture_output=True, text=True,
        )
        return r.stdout.strip() if r.returncode == 0 else "gone"

    def _tail_logs(self) -> str:
        """Last few log lines, for an error that would otherwise name only a symptom."""
        r = subprocess.run(
            ["docker", "logs", "--tail", "40", self._name], capture_output=True, text=True,
        )
        return (r.stdout + r.stderr).strip() if r.returncode == 0 else "(docker logs unavailable)"

    def _wait_ready(self) -> None:
        import pg8000.dbapi  # local import — pg8000 lives in the `integration` extra
        timeout_s = int(os.environ.get("MO_PG_READY_TIMEOUT_S", "120"))
        deadline = time.monotonic() + timeout_s
        last_err: Exception | None = None
        while time.monotonic() < deadline:
            # FAIL FAST ON A DEAD CONTAINER. `docker exec` alone cannot tell "still
            # booting" from "exited seconds ago" -- both just fail -- so a container that
            # died on startup used to burn the whole window and report a TIMEOUT, which
            # reads as slowness and is not. Ask docker for its state and surface its logs.
            state = self._inspect_state()
            if state != "running":
                raise RuntimeError(
                    f"postgres container '{self._name}' is '{state}', not running -- it died "
                    f"during startup rather than being slow. docker logs:\n{self._tail_logs()}"
                )
            ready = subprocess.run(
                ["docker", "exec", self._name, "pg_isready", "-U", self.USER],
                capture_output=True,
            )
            if ready.returncode == 0:
                try:
                    conn = pg8000.dbapi.connect(
                        host="localhost", port=self._port,
                        user=self.USER, password=self.PASSWORD, database=self.DATABASE,
                    )
                    conn.close()
                    return
                except Exception as e:  # noqa: BLE001 — driver may throw any kind of error mid-boot
                    last_err = e
            time.sleep(0.25)
        raise RuntimeError(
            f"postgres container '{self._name}' did not become ready within {timeout_s}s "
            f"(state={self._inspect_state()}); last err: {last_err}. "
            f"docker logs:\n{self._tail_logs()}"
        )


def _docker(*args: str) -> str:
    """Run a docker command, returning trimmed stdout. Raises on non-zero exit."""
    r = subprocess.run(["docker", *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise subprocess.CalledProcessError(
            r.returncode, ["docker", *args], output=r.stdout, stderr=r.stderr,
        )
    return r.stdout.strip()


def _pick_free_port() -> int:
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])
