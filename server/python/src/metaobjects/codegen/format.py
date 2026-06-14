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
        raise RuntimeError(f"ruff {args[0]} failed: {proc.stderr.strip()}")
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
