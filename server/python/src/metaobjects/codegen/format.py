"""Format pass over emitted source via `ruff format` (reads stdin, writes stdout)."""
from __future__ import annotations

import subprocess
import sys


def ruff_format(source: str) -> str:
    """Run `ruff format -` over *source*; return the formatted text.
    Raises RuntimeError if ruff fails (e.g. a syntax error in emitted code)."""
    proc = subprocess.run(
        [sys.executable, "-m", "ruff", "format", "-"],
        input=source,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ruff format failed: {proc.stderr.strip()}")
    return proc.stdout
