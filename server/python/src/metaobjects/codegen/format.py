"""Canonicalize emitted source via ruff: sort imports (isort), then format.

Both passes read stdin / write stdout, so generated code is import-sorted AND
formatted — i.e. `ruff check`- and `ruff format`-clean for downstream consumers."""
from __future__ import annotations

import importlib.util
import subprocess
import sys

_STDIN_NAME = "generated.py"

#: ruff is a codegen-time convenience (import-sort + format), not a runtime requirement
#: of the emitted code. When it's absent we emit valid-but-unformatted Python rather
#: than hard-failing the whole ``gen``.
_RUFF_AVAILABLE = importlib.util.find_spec("ruff") is not None


def _run_ruff(args: list[str], source: str) -> str:
    proc = subprocess.run(
        [sys.executable, "-m", "ruff", *args],
        input=source,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        # A non-zero exit is read by the caller as "ruff rejected the source" — a
        # generator bug. A NEGATIVE code is not that: it is death by signal, and a
        # killed process writes no stderr, so this branch used to raise
        # `ruff format failed:` naming neither the cause nor the fact that ruff never
        # looked at the source. Seen on a CI box running five lanes at once, where the
        # formatter was OOM-killed and the message sent the reader hunting a syntax
        # error that did not exist. Always carry the code; never claim a source error
        # for a process that did not finish.
        detail = proc.stderr.strip()
        if proc.returncode < 0:
            raise RuntimeError(
                f"ruff {args[0]} was killed by signal {-proc.returncode} before it could "
                f"format the source — this is not a generator bug; the machine most likely "
                f"ran out of memory" + (f": {detail}" if detail else "")
            )
        raise RuntimeError(
            f"ruff {args[0]} failed (exit {proc.returncode})"
            + (f": {detail}" if detail else " and wrote nothing to stderr")
        )
    return proc.stdout


def ruff_format(source: str) -> str:
    """Sort imports then format *source*; return the canonical text.

    A no-op (returns *source* unchanged) when ruff is not installed — the emitted
    code is still valid Python, just unformatted. Still raises RuntimeError if ruff
    IS present but fails (e.g. a syntax error in emitted code — that's a generator bug)."""
    if not _RUFF_AVAILABLE:
        return source
    sorted_src = _run_ruff(
        ["check", "--select", "I", "--fix", "--stdin-filename", _STDIN_NAME, "-"], source
    )
    return _run_ruff(["format", "-"], sorted_src)
