"""Spin up a fresh Postgres container per scenario by shelling out to docker.

Mirrors the TS/Java/C# integration suites. Avoids the python-testcontainers
package + its docker API negotiation churn (the same kind of mismatch
testcontainers-java hits against Docker Engine 29+).
"""
from __future__ import annotations

import socket
import subprocess
import time
import uuid
from contextlib import closing
from dataclasses import dataclass


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
    USER = "postgres"
    PASSWORD = "test"
    DATABASE = "postgres"

    def __init__(self) -> None:
        self._name = f"metaobjects-test-{uuid.uuid4().hex[:8]}"
        self._port = _pick_free_port()
        _docker(
            "run", "-d", "--rm",
            "--name", self._name,
            "-e", f"POSTGRES_PASSWORD={self.PASSWORD}",
            "-p", f"{self._port}:5432",
            self.IMAGE,
        )
        self._wait_ready()

    def info(self) -> PostgresInfo:
        return PostgresInfo(
            host="localhost", port=self._port, database=self.DATABASE,
            user=self.USER, password=self.PASSWORD,
        )

    def stop(self) -> None:
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

    def _wait_ready(self) -> None:
        import pg8000.dbapi  # local import — pg8000 lives in the `integration` extra
        deadline = time.monotonic() + 30
        last_err: Exception | None = None
        while time.monotonic() < deadline:
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
            f"postgres container '{self._name}' did not become ready within 30s; last err: {last_err}"
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
