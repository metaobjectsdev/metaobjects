"""Conformance runner — one parametrized test per fixture (porting guide §6)."""
from __future__ import annotations

import json

import pytest

from .conformance_adapter import load_fixture
from .corpus import corpus_root
from .expected_failures import classify
from .fixture_discovery import Fixture, discover_fixtures

_FIXTURES = discover_fixtures(corpus_root())


def _run_checks(fix: Fixture) -> tuple[bool, str]:
    codes, warnings, canonical = load_fixture(fix.input_dir)
    failures: list[str] = []

    if fix.has_expected_errors:
        # expected-errors.json is an array of {"code": "ERR_*"} objects; extract codes only
        raw = json.loads((fix.dir / "expected-errors.json").read_text())
        want = sorted(entry["code"] for entry in raw)
        got = sorted(codes)
        if want != got:
            failures.append(f"errors: want {want} got {got}")

    tree_blocked = bool(codes) and not fix.has_expected_errors and fix.has_expected
    if tree_blocked:
        failures.append(f"load produced errors {codes}; cannot run tree checks")

    if fix.has_expected and not tree_blocked:
        want_tree = json.loads((fix.dir / "expected.json").read_text())
        got_tree = json.loads(canonical)
        if want_tree != got_tree:
            failures.append("canonical serialization mismatch")

    if fix.has_expected_warnings:
        want_w = sorted(json.loads((fix.dir / "expected-warnings.json").read_text()))
        if want_w != sorted(warnings):
            failures.append(f"warnings: want {want_w} got {sorted(warnings)}")
    elif fix.has_expected and not tree_blocked and warnings:
        failures.append(f"unexpected warnings: {warnings}")

    # Phase 1 does not run script.json (navigate/invoke) checks. A fixture that
    # declares one is therefore not fully verified — count it as a tracked gap so
    # its green status can't imply a capability we haven't checked yet (Phase 2).
    if fix.has_script:
        failures.append("script.json checks not implemented (Phase 2)")

    return (not failures), "; ".join(failures)


@pytest.mark.parametrize("fix", _FIXTURES, ids=[f.name for f in _FIXTURES])
def test_conformance(fix: Fixture) -> None:
    passed, detail = _run_checks(fix)
    status = classify(passed, fix.name)
    assert status in ("pass", "known-gap"), f"{fix.name} [{status}]: {detail}"
