"""Locate the shared conformance corpus relative to this file (repo public; no hardcoded paths)."""
from __future__ import annotations

from pathlib import Path


def corpus_root() -> Path:
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        candidate = parent / "fixtures" / "conformance"
        if candidate.is_dir():
            return candidate
    raise RuntimeError("could not locate fixtures/conformance from " + str(here))
