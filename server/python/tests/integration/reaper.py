"""Ryuk, the Testcontainers reaper, for containers started through the docker CLI.

A fixture's teardown cannot run in a killed process: SIGKILL, the kernel OOM killer and earlyoom
all skip it, and a plain SIGTERM ends Python without running it. Ryuk closes that gap from outside
the process. It runs in its own container and holds one TCP connection from each client. When the
last connection closes, for any reason, it waits ten seconds and removes everything carrying the
session labels it was given. The operating system closes the socket of a killed process, so no
code in the dying process has to run.

Each process starts a private Ryuk here, so an xdist worker's death reaps that worker's containers
and no other run's. ``TESTCONTAINERS_RYUK_DISABLED=true`` turns the reaper off.

This is not the testcontainers package's ``Reaper``, for two reasons. That class defaults to Ryuk
0.8.1, which tries each removal once, drops the error and exits, so a single failed ``rm -f``
leaves the container running for good while its log says it was removed. It cannot run a newer
image, because it waits for a log line 0.10 and later no longer print. It also never reads Ryuk's
ACK, so it cannot tell a registered session from a connection that went nowhere. Ryuk 0.14.0
retries a failed removal, and :func:`_register` waits for the ACK.

A Ryuk that no client reaches stops by itself after a minute, and ``--rm`` removes it.
"""
from __future__ import annotations

import os
import socket
import subprocess
import time
import uuid

RYUK_IMAGE = "testcontainers/ryuk:0.14.0"
SESSION_LABEL = "org.testcontainers.session-id"
DOCKER_SOCKET_ENV = "TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE"
DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock"
#: Long enough to pull the image once.
DOCKER_RUN_TIMEOUT_S = 180
REGISTER_DEADLINE_S = 15
REGISTER_ATTEMPT_TIMEOUT_S = 5
REGISTER_RETRY_DELAY_S = 0.2

_label_args: list[str] | None = None
#: Held here for the life of the process: losing this connection ends the session.
_ryuk_connection: socket.socket | None = None
#: The container this process started, so a test can read its log.
ryuk_name: str | None = None


def docker_socket() -> str:
    """The daemon socket Ryuk is handed, which is the path as the daemon sees it."""
    return os.environ.get(DOCKER_SOCKET_ENV, DEFAULT_DOCKER_SOCKET)


def _register(port: int, label: str) -> socket.socket | None:
    """One registration attempt. Docker publishes the port before Ryuk listens, so a refused or
    reset connection only means "not yet". Only the ACK proves Ryuk holds the label."""
    try:
        conn = socket.create_connection(("127.0.0.1", port), timeout=REGISTER_ATTEMPT_TIMEOUT_S)
    except OSError:
        return None
    try:
        conn.sendall(f"label={label}\n".encode())
        with conn.makefile("rb") as replies:
            if replies.readline() == b"ACK\n":
                return conn
    except OSError:
        pass
    conn.close()
    return None


def _start_reaper() -> list[str]:
    global _ryuk_connection, ryuk_name
    # Imported here because postgres_container imports this module.
    from .postgres_container import published_port

    session = uuid.uuid4().hex
    name = f"metaobjects-test-ryuk-{session[:8]}"
    label = f"{SESSION_LABEL}={session}"
    run = subprocess.run(
        ["docker", "run", "-d", "--rm", "--name", name,
         "-v", f"{docker_socket()}:{DEFAULT_DOCKER_SOCKET}",
         "-p", "127.0.0.1::8080",
         RYUK_IMAGE],
        capture_output=True, text=True, timeout=DOCKER_RUN_TIMEOUT_S,
    )
    failure = f"docker run failed: {run.stderr}"
    if run.returncode == 0:
        failure = f"no ACK within {REGISTER_DEADLINE_S}s"
        port = published_port(name, 8080)
        deadline = time.monotonic() + REGISTER_DEADLINE_S
        while time.monotonic() < deadline:
            _ryuk_connection = _register(port, label)
            if _ryuk_connection is not None:
                ryuk_name = name
                return ["--label", label]
            time.sleep(REGISTER_RETRY_DELAY_S)
    subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=30)
    raise RuntimeError(f"could not start Ryuk ({RYUK_IMAGE}): {failure}")


def reaper_label_args() -> list[str]:
    """Flags for ``docker run``. The first call starts this process's Ryuk, and must finish before
    the container starts, so a process killed at any later moment is covered."""
    global _label_args
    if os.environ.get("TESTCONTAINERS_RYUK_DISABLED", "").lower() == "true":
        return []
    if _label_args is None:
        _label_args = _start_reaper()
    return _label_args
