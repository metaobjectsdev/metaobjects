"""Ryuk, the Testcontainers reaper, for containers started through the docker CLI.

A fixture's teardown cannot run in a killed process: SIGKILL, the kernel OOM killer and earlyoom
all skip it, and a plain SIGTERM ends Python without running it. Ryuk closes that gap from outside
the process. It runs in its own container and holds one TCP connection per session. When that
connection closes, for any reason, it waits ten seconds and removes everything carrying the
session's label. The operating system closes the socket of a killed process, so no code in the
dying process has to run.

Each process gets its own session, so an xdist worker's death reaps that worker's containers and
no other run's. ``TESTCONTAINERS_RYUK_DISABLED=true`` turns the reaper off.
"""
from __future__ import annotations


def reaper_label_args() -> list[str]:
    """Flags for ``docker run``. The first call starts Ryuk, and must finish before the container
    starts, so a process killed at any later moment is covered."""
    # Imported here because the sidecar path never starts a container and should not load docker.
    from testcontainers.core.config import testcontainers_config
    from testcontainers.core.container import Reaper
    from testcontainers.core.labels import LABEL_SESSION_ID, SESSION_ID

    if not testcontainers_config.ryuk_disabled:
        Reaper.get_instance()
    return ["--label", f"{LABEL_SESSION_ID}={SESSION_ID}"]
