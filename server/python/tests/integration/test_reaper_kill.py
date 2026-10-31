"""A killed process removes its container.

Public behaviour: once a process that started a helper container dies without running its
teardown, Docker stops listing that container. The oracle is Docker itself, queried from outside
the killed process. A helper that labels nothing, or a reaper that accepts the label and removes
nothing, fails on the deadline. So does a reaper that gives up on the first failed removal, which
the refused-removal test pins by making Docker refuse one ``rm -f``. Ryuk 0.8.1 then left the
container running and reported it removed.
"""
from __future__ import annotations

import http.client
import json
import os
import re
import shutil
import signal
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path

from .reaper import DOCKER_SOCKET_ENV, _register, docker_socket

CHILD = """
import time
from tests.integration import reaper
from tests.integration.postgres_container import PostgresContainer
pg = PostgresContainer()
print("READY", pg.info().port, reaper.ryuk_name, flush=True)
time.sleep(600)
"""

CHILD_READY_S = 60
#: Ryuk waits 10s, then Docker has to finish the container's exit, and it cannot until the overlay
#: unmount has flushed the host filesystem's dirty pages. A busy disk makes removal slow, not wrong.
#: Measured with a 256 MiB backlog: 34-38s at 12 MB/s and 67-76s at 6 MB/s, on Ryuk 0.8.1 and 0.14.0
#: alike, against under 11s at 6 MB/s with no backlog. Every removal succeeded.
REMOVAL_BOUND_S = 120
PYTHON_ROOT = Path(__file__).resolve().parents[2]
LABEL = "org.testcontainers.session-id=test"


def _docker(*args: str) -> str:
    return subprocess.run(
        ["docker", *args], capture_output=True, text=True, check=True, timeout=30
    ).stdout.strip()


def _status(name: str) -> str:
    """What Docker lists for *name*: "" once it is gone, otherwise Up, Exited, Dead or Removal
    In Progress, which is what tells a removal that never ran from one that failed."""
    return _docker("ps", "-a", "--filter", f"name=^{name}$", "--format", "{{.Status}}")


def _await_ready(child: subprocess.Popen[bytes], output: Path) -> tuple[str, str]:
    deadline = time.monotonic() + CHILD_READY_S
    while time.monotonic() < deadline and child.poll() is None:
        ready = re.search(r"^READY (\d+) (\S+)$", output.read_text(), re.MULTILINE)
        if ready:
            return ready.group(1), ready.group(2)
        time.sleep(0.25)
    raise AssertionError(f"reaper child never reported its container:\n{output.read_text()}")


def _kill_child_and_expect_removal(tmp_path: Path, extra_env: dict[str, str]) -> None:
    env = {k: v for k, v in os.environ.items() if k != "METAOBJECTS_TEST_PG_URL"} | extra_env
    output = tmp_path / "child.log"
    with output.open("wb") as log:
        child = subprocess.Popen(
            [sys.executable, "-c", CHILD], cwd=PYTHON_ROOT, env=env,
            stdout=log, stderr=subprocess.STDOUT,
        )
    container = ""
    ryuk_log = tmp_path / "ryuk.log"
    follower = None
    try:
        port, ryuk = _await_ready(child, output)
        container = _docker("ps", "--filter", f"publish={port}/tcp", "--format", "{{.Names}}")
        assert container != ""
        # `--rm` takes Ryuk's log with it, and that log is the evidence if this ever fails.
        with ryuk_log.open("wb") as log:
            follower = subprocess.Popen(
                ["docker", "logs", "-f", ryuk], stdout=log, stderr=subprocess.STDOUT
            )

        child.send_signal(signal.SIGKILL)
        child.wait(timeout=30)

        deadline = time.monotonic() + REMOVAL_BOUND_S
        while _status(container) and time.monotonic() < deadline:
            time.sleep(0.25)
        status = _status(container)
        assert not status, (
            f"{container} outlived its killed process ({status})\n{ryuk_log.read_text()}"
        )
    finally:
        child.kill()
        child.wait(timeout=30)
        if follower is not None:
            follower.kill()
            follower.wait(timeout=30)
        if container:
            subprocess.run(["docker", "rm", "-f", "-v", container], capture_output=True, timeout=30)


def test_killed_process_removes_its_container(tmp_path: Path) -> None:
    _kill_child_and_expect_removal(tmp_path, {})


class _UnixHttpConnection(http.client.HTTPConnection):
    def __init__(self, path: str) -> None:
        super().__init__("localhost")
        self._path = path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.connect(self._path)


class _RefusingDockerApi(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    """The Docker API, except that the first container removal fails with the error the daemon
    returns for a container that did not exit in time. Everything else reaches the real daemon."""

    daemon_threads = True

    def __init__(self, path: str, upstream: str) -> None:
        self.upstream = upstream
        self.refused = 0
        super().__init__(path, _RefusingHandler)
        os.chmod(path, 0o666)  # Ryuk connects from inside its container

    def get_request(self) -> tuple[socket.socket, tuple[str, int]]:
        # BaseHTTPRequestHandler reads a host and port off the client address.
        return self.socket.accept()[0], ("docker", 0)


class _RefusingHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: _RefusingDockerApi

    def log_message(self, format: str, *args: object) -> None:
        pass

    def _reply(self, status: int, headers: list[tuple[str, str]], body: bytes) -> None:
        self.send_response(status)
        for key, value in headers:
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _forward(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        removal = self.command == "DELETE" and "/containers/" in self.path
        if removal and self.server.refused == 0:
            self.server.refused += 1
            message = "could not kill container: tried to kill container, but did not receive an exit event"
            self._reply(500, [("Content-Type", "application/json")], json.dumps({"message": message}).encode())
            return
        upstream = _UnixHttpConnection(self.server.upstream)
        upstream.request(self.command, self.path, body=body, headers=dict(self.headers))
        response = upstream.getresponse()
        hop_by_hop = {"connection", "content-length", "transfer-encoding"}
        headers = [(k, v) for k, v in response.getheaders() if k.lower() not in hop_by_hop]
        self._reply(response.status, headers, response.read())
        upstream.close()

    do_DELETE = do_GET = do_HEAD = do_POST = _forward


def test_a_removal_that_fails_once_is_retried(tmp_path: Path) -> None:
    # Not tmp_path: a Unix socket path has a length limit that pytest's nested directories can pass.
    directory = tempfile.mkdtemp(prefix="reaper-", dir="/tmp")
    path = os.path.join(directory, "docker.sock")
    api = _RefusingDockerApi(path, docker_socket())
    threading.Thread(target=api.serve_forever, daemon=True).start()
    try:
        _kill_child_and_expect_removal(tmp_path, {DOCKER_SOCKET_ENV: path})
        assert api.refused == 1, "Ryuk never asked to remove the container"
    finally:
        api.shutdown()
        api.server_close()
        shutil.rmtree(directory)


def _one_shot_server(reply: bytes) -> socket.socket:
    """A listener that answers one registration with *reply*, then hangs up unless it said ACK."""
    server = socket.create_server(("127.0.0.1", 0))

    def answer() -> None:
        conn, _ = server.accept()
        conn.recv(256)
        conn.sendall(reply)
        if reply != b"ACK\n":
            conn.close()

    threading.Thread(target=answer, daemon=True).start()
    return server


def test_a_connection_ryuk_never_acknowledged_is_not_a_registration() -> None:
    with _one_shot_server(b"") as server:
        assert _register(server.getsockname()[1], LABEL) is None


def test_a_connection_ryuk_acknowledged_is_held_open() -> None:
    with _one_shot_server(b"ACK\n") as server:
        conn = _register(server.getsockname()[1], LABEL)
        assert conn is not None
        conn.close()
