"""Conformance runner — one parametrized test per fixture (porting guide §6)."""
from __future__ import annotations

import json

import pytest

from .capabilities import invoke
from .conformance_adapter import load_fixture_result, load_fixture_with_envelopes
from .corpus import corpus_root
from .expected_failures import classify
from .fixture_discovery import Fixture, discover_fixtures
from .navigator import navigate

_FIXTURES = discover_fixtures(corpus_root())


def _parse_expected_errors(raw: object) -> tuple[list[dict], int, bool]:
    """Accept both legacy ``[{code}]`` and FR5a envelope shapes.

    Returns (errors, warnings_count, legacy_flag).
    """
    if isinstance(raw, list):
        return ([{"code": e["code"], "source": None} for e in raw], 0, True)
    if isinstance(raw, dict) and "errors" in raw and isinstance(raw["errors"], list):
        errors = []
        for idx, e in enumerate(raw["errors"]):
            src = e.get("source")
            if isinstance(src, dict):
                # FR5d — format=resolved requires both referrer and target.
                if src.get("format") == "resolved":
                    if "referrer" not in src:
                        raise ValueError(
                            f"expected-errors.json entry {idx}: "
                            "'source.referrer' is required when format='resolved'")
                    if "target" not in src:
                        raise ValueError(
                            f"expected-errors.json entry {idx}: "
                            "'source.target' is required when format='resolved'")
            errors.append({
                "code": e["code"],
                "source": src if isinstance(src, dict) else None,
            })
        warnings = raw.get("warnings", [])
        wc = len(warnings) if isinstance(warnings, list) else 0
        return (errors, wc, False)
    raise ValueError(
        "expected-errors.json must be a legacy array or an FR5a envelope object")


def _run_checks(fix: Fixture) -> tuple[bool, str]:
    codes, envelopes, warnings, canonical = load_fixture_with_envelopes(fix.input_dir)
    failures: list[str] = []

    if fix.has_expected_errors:
        raw = json.loads((fix.dir / "expected-errors.json").read_text())
        expected_errors, expected_warnings_count, legacy = _parse_expected_errors(raw)

        # Code-set check (order-independent) — legacy semantics, always run.
        want = sorted(e["code"] for e in expected_errors)
        got = sorted(codes)
        if want != got:
            failures.append(f"errors: want {want} got {got}")

        # FR5a — per-error envelope assertion (in declaration order).
        if not legacy:
            if len(expected_errors) != len(envelopes):
                failures.append(
                    f"envelope length mismatch: expected {len(expected_errors)}, "
                    f"got {len(envelopes)}"
                )
            else:
                for i, (w, g) in enumerate(zip(expected_errors, envelopes)):
                    if w["code"] != g.code:
                        failures.append(
                            f"envelope[{i}].code: expected '{w['code']}', got '{g.code}'")
                        continue
                    src = w["source"]
                    if src is None:
                        continue
                    if src["format"] != g.format:
                        failures.append(
                            f"envelope[{i}].source.format: expected '{src['format']}', got '{g.format}'")
                    want_files = tuple(src["files"])
                    if want_files != g.files:
                        failures.append(
                            f"envelope[{i}].source.files: expected {list(want_files)}, "
                            f"got {list(g.files)}")
                    want_path = src.get("jsonPath")
                    if want_path is not None and want_path != g.json_path:
                        failures.append(
                            f"envelope[{i}].source.jsonPath: expected '{want_path}', "
                            f"got '{g.json_path}'")
                    # FR5d — assert referrer / target for format=resolved envelopes.
                    want_ref = src.get("referrer")
                    if want_ref is not None and want_ref != g.referrer:
                        failures.append(
                            f"envelope[{i}].source.referrer: expected '{want_ref}', "
                            f"got '{g.referrer}'")
                    want_tgt = src.get("target")
                    if want_tgt is not None and want_tgt != g.target:
                        failures.append(
                            f"envelope[{i}].source.target: expected '{want_tgt}', "
                            f"got '{g.target}'")
            # warnings count check (FR5a fixtures all have []).
            if expected_warnings_count != len(warnings):
                failures.append(
                    f"warnings count: expected {expected_warnings_count}, "
                    f"got {len(warnings)}")

    # Tree-check: run whenever expected.json exists, matching the TS reference
    # runner. A load that produced errors still gets its tree compared —
    # canonical_serialize emits whatever subtree the loader built before
    # bailing, and the comparison surfaces real divergence. Fixtures that
    # legitimately can't produce a tree have no expected.json (they ship
    # expected-errors.json instead).
    if fix.has_expected:
        want_tree = json.loads((fix.dir / "expected.json").read_text())
        got_tree = json.loads(canonical)
        if want_tree != got_tree:
            failures.append("canonical serialization mismatch")

    if fix.has_expected_warnings:
        want_w = sorted(json.loads((fix.dir / "expected-warnings.json").read_text()))
        if want_w != sorted(warnings):
            failures.append(f"warnings: want {want_w} got {sorted(warnings)}")
    elif fix.has_expected and warnings:
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
