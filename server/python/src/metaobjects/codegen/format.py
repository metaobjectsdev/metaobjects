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
        # generator bug. Two things make that reading unsafe, so record what actually
        # happened instead of asserting a cause.
        #
        # First, ruff reports a source it cannot parse as exit 2 WITH stderr (measured,
        # ruff 0.15.14: `error: Failed to parse at 1:7: ...`). So an EMPTY stderr is not
        # a source rejection — the process did not get far enough to say anything.
        # Second, a NEGATIVE returncode is death by signal, which is not a verdict on
        # the source at all.
        #
        # This branch used to raise `ruff format failed:` — trailing off after the colon
        # whenever stderr was empty, naming neither the exit status nor the fact that
        # ruff never looked at the source, and sending a reader hunting a syntax error
        # that did not exist. Always carry the status; never claim a source error for a
        # process that did not finish, and do not guess at WHY it did not finish.
        detail = proc.stderr.strip()
        if proc.returncode < 0:
            raise RuntimeError(
                f"ruff {args[0]} was killed by signal {-proc.returncode} before it could "
                f"format the source — this is not a source error; the formatter never ran "
                f"to completion" + (f": {detail}" if detail else "")
            )
        raise RuntimeError(
            f"ruff {args[0]} failed (exit {proc.returncode})"
            + (
                f": {detail}"
                if detail
                else " and wrote nothing to stderr — ruff reports an unparseable source"
                     " WITH stderr, so this is not a source error"
            )
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
