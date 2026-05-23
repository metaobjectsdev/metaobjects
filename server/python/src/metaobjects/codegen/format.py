"""Canonicalize emitted source via ruff: sort imports (isort), then format.

Both passes read stdin / write stdout, so generated code is import-sorted AND
formatted — i.e. `ruff check`- and `ruff format`-clean for downstream consumers."""
from __future__ import annotations

import subprocess
import sys

_STDIN_NAME = "generated.py"


def _run_ruff(args: list[str], source: str) -> str:
    proc = subprocess.run(
        [sys.executable, "-m", "ruff", *args],
        input=source,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ruff {args[0]} failed: {proc.stderr.strip()}")
    return proc.stdout


def ruff_format(source: str) -> str:
    """Sort imports then format *source*; return the canonical text.
    Raises RuntimeError if ruff fails (e.g. a syntax error in emitted code)."""
    sorted_src = _run_ruff(
        ["check", "--select", "I", "--fix", "--stdin-filename", _STDIN_NAME, "-"], source
    )
    return _run_ruff(["format", "-"], sorted_src)
