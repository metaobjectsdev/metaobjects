"""Conformance runner — one parametrized test per fixture (porting guide §6)."""
from __future__ import annotations

import json

import pytest

from .capabilities import invoke
from .conformance_adapter import load_fixture, load_fixture_result
from .corpus import corpus_root
from .expected_failures import classify
from .fixture_discovery import Fixture, discover_fixtures
from .navigator import navigate

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

    if fix.has_script:
        script = json.loads((fix.dir / "script.json").read_text())
        result = load_fixture_result(fix.input_dir)
        root = result.root
        for i, op in enumerate(script.get("operations", [])):
            path: list[str] = op["navigate"]
            cap: str = op["invoke"]
            args: dict[str, object] = op.get("args", {})
            expected: dict[str, object] = op["expect"]

            node = navigate(root, path)
            if node is None:
                failures.append(f"script op {i}: navigate {path!r} resolved to None")
                continue

            try:
                actual = invoke(node, cap, args)
            except (ValueError, TypeError) as exc:
                failures.append(f"script op {i}: invoke {cap!r} raised {exc}")
                continue

            if actual != expected:
                failures.append(
                    f"script op {i} ({cap!r}): expected {expected!r}, got {actual!r}"
                )

    return (not failures), "; ".join(failures)


@pytest.mark.parametrize("fix", _FIXTURES, ids=[f.name for f in _FIXTURES])
def test_conformance(fix: Fixture) -> None:
    passed, detail = _run_checks(fix)
    status = classify(passed, fix.name)
    assert status in ("pass", "known-gap"), f"{fix.name} [{status}]: {detail}"
