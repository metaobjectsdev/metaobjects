"""A test database lives in RAM and never outlives the run that started it.

Storage. Each database image declares a ``VOLUME`` for its data directory. A container started
without a mount there gets an anonymous volume on disk, which stays behind after the container
is removed without ``-v``. Every launcher therefore mounts a size-capped tmpfs at that path
(:func:`ram_volume`), and Postgres runs with durability off (:data:`POSTGRES_DURABILITY_OFF`):
nothing written to a throwaway database needs to survive a crash.

Removal. Teardown in a fixture runs only when the process gets that far. Ryuk (see
:mod:`reaper`) removes the containers of a killed process from outside it. This module covers
the cases Ryuk does not: a run with ``TESTCONTAINERS_RYUK_DISABLED=true``, and a plain SIGTERM,
which ends Python without running a fixture's teardown. Every container a launcher starts is
registered with :func:`remove_on_exit`; it is removed at interpreter exit and on SIGTERM unless
its launcher already removed it and called :func:`forget`.
"""
from __future__ import annotations

import atexit
import os
import signal
import subprocess
import threading
from types import FrameType

#: Upper bound for one database's data directory. A tmpfs takes RAM only for what is written.
TMPFS_SIZE = "2g"

#: ``postgres`` server options for a database whose contents may be lost at any moment.
POSTGRES_DURABILITY_OFF: tuple[str, ...] = (
    "-c", "fsync=off",
    "-c", "synchronous_commit=off",
    "-c", "full_page_writes=off",
)


def ram_volume(path: str) -> tuple[str, str]:
    """``docker run`` flags mounting a size-capped tmpfs at *path*, the image's ``VOLUME``."""
    return ("--tmpfs", f"{path}:rw,size={TMPFS_SIZE}")


_lock = threading.Lock()
_started: set[str] = set()
_hooks_installed = False


def remove_on_exit(name: str) -> None:
    """Remove container *name* when this process exits or receives SIGTERM."""
    global _hooks_installed
    with _lock:
        _started.add(name)
        if _hooks_installed:
            return
        _hooks_installed = True
    atexit.register(_remove_all)
    _chain_sigterm()


def forget(name: str) -> None:
    """*name* was removed by its launcher; nothing is left to do for it at exit."""
    with _lock:
        _started.discard(name)


def _remove_all() -> None:
    with _lock:
        names = sorted(_started)
        _started.clear()
    if names:
        subprocess.run(["docker", "rm", "-f", "-v", *names], capture_output=True, timeout=120)


def _chain_sigterm() -> None:
    """Remove the containers on SIGTERM, then end the process as the signal would have.
    Signal handlers can be installed only from the main thread; elsewhere the atexit hook and
    Ryuk still apply."""
    if threading.current_thread() is not threading.main_thread():
        return
    previous = signal.getsignal(signal.SIGTERM)
    if previous is signal.SIG_IGN:
        return

    def on_sigterm(signum: int, frame: FrameType | None) -> None:
        _remove_all()
        if callable(previous):
            previous(signum, frame)
            return
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        os.kill(os.getpid(), signal.SIGTERM)

    signal.signal(signal.SIGTERM, on_sigterm)
