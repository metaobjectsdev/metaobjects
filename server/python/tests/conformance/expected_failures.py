"""Expected-failures ledger classifier (porting guide §6)."""
from __future__ import annotations

import json
from pathlib import Path

_LEDGER_PATH = Path(__file__).with_name("conformance-expected-failures.json")


def _ledger() -> set[str]:
    if not _LEDGER_PATH.is_file():
        return set()
    return set(json.loads(_LEDGER_PATH.read_text()).get("fixtures", []))


def classify(passed: bool, name: str) -> str:
    listed = name in _ledger()
    if not passed:
        return "known-gap" if listed else "fail"
    return "fixed-but-listed" if listed else "pass"
