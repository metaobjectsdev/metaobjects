"""A killed process removes its container.

Public behaviour: once a process that started a helper container dies without running its
teardown, Docker stops listing that container. The oracle is Docker itself, queried from outside
the killed process. A helper that labels nothing, or a reaper that accepts the label and removes
nothing, fails on the deadline.
"""
from __future__ import annotations

import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

CHILD = """
import time
from tests.integration.postgres_container import PostgresContainer
pg = PostgresContainer()
print("READY", pg.info().port, flush=True)
time.sleep(600)
"""

CHILD_READY_S = 60
REMOVAL_BOUND_S = 45
PYTHON_ROOT = Path(__file__).resolve().parents[2]


def _docker(*args: str) -> str:
    return subprocess.run(
        ["docker", *args], capture_output=True, text=True, check=True, timeout=30
    ).stdout.strip()


def _exists(name: str) -> bool:
    return _docker("ps", "-a", "--filter", f"name=^{name}$", "--format", "{{.Names}}") != ""


def _await_port(child: subprocess.Popen[bytes], output: Path) -> str:
    deadline = time.monotonic() + CHILD_READY_S
    while time.monotonic() < deadline and child.poll() is None:
        ready = re.search(r"^READY (\d+)$", output.read_text(), re.MULTILINE)
        if ready:
            return ready.group(1)
        time.sleep(0.25)
    raise AssertionError(f"reaper child never reported its container:\n{output.read_text()}")


def test_killed_process_removes_its_container(tmp_path: Path) -> None:
    env = {k: v for k, v in os.environ.items() if k != "METAOBJECTS_TEST_PG_URL"}
    output = tmp_path / "child.log"
    with output.open("wb") as log:
        child = subprocess.Popen(
            [sys.executable, "-c", CHILD], cwd=PYTHON_ROOT, env=env,
            stdout=log, stderr=subprocess.STDOUT,
        )
    container = ""
    try:
        port = _await_port(child, output)
        container = _docker("ps", "--filter", f"publish={port}/tcp", "--format", "{{.Names}}")
        assert container != ""

        child.send_signal(signal.SIGKILL)
        child.wait(timeout=30)

        deadline = time.monotonic() + REMOVAL_BOUND_S
        while _exists(container) and time.monotonic() < deadline:
            time.sleep(0.25)
        assert not _exists(container), f"{container} outlived its killed process"
    finally:
        child.kill()
        child.wait(timeout=30)
        if container:
            subprocess.run(["docker", "rm", "-f", "-v", container], capture_output=True, timeout=30)
