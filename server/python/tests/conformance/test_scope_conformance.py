"""Runs the shared scope-pattern corpus against this port.

Reads `fixtures/scope-conformance/cases.json` — the single committed source of
truth, shared with the TS runner (`metadata/test/scope-conformance.test.ts`,
re-run unchanged through sdk's re-export at `sdk/test/scope-conformance.test.ts`).
There is no per-port fixture.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.errors import ErrorCode, ParseError
from metaobjects.scope import compile_scope, matches_scope

_CORPUS = (
    Path(__file__).resolve().parents[4]
    / "fixtures"
    / "scope-conformance"
    / "cases.json"
)

_CASES = json.loads(_CORPUS.read_text())["cases"]


def test_corpus_is_non_empty() -> None:
    """A silent zero-case run is a failed gate, not a pass.

    `@pytest.mark.parametrize` over an empty list simply collects zero tests —
    pytest reports that as a SKIP, not a failure, so a corpus that quietly lost
    its cases (e.g. a bad path, a JSON-parsing bug) would report green here
    with nothing actually checked. Mirrors the TS runner's identically-named
    guard (`scope-conformance.test.ts`).
    """
    assert len(_CASES) > 0


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_scope_conformance_case(case: dict) -> None:
    scope = case["scope"]
    include = scope.get("include")
    exclude = scope.get("exclude")

    expect_error = case.get("expectError")
    if expect_error is not None:
        with pytest.raises(ParseError) as excinfo:
            compile_scope(include, exclude)
        assert excinfo.value.code == ErrorCode.ERR_SCOPE_PATTERN_INVALID
        return

    compiled = compile_scope(include, exclude)
    for entry in case["expect"]:
        fqn = entry["fqn"]
        assert matches_scope(fqn, compiled) == entry["matches"], (
            f"case {case['name']!r}: matches_scope({fqn!r}, ...) expected "
            f"{entry['matches']!r}"
        )


def test_scope_pattern_does_not_match_a_trailing_newline() -> None:
    """Carried minor (Task 4 review): Python's `re.match` lets a compiled
    `^...$` pattern match a string with a trailing newline, because bare `$`
    matches just before it — a divergence from JS, where `$` never does that.
    `matches_scope` must use `re.fullmatch` so the two ports agree.

    A wildcarded pattern (`acme::*`) does not exercise this: its trailing
    `[^:]*` legitimately consumes a literal `\\n` as content, so `match` and
    `fullmatch` agree. Only a literal, non-wildcarded pattern isolates the
    `$`-before-trailing-newline behavior this fixes.
    """
    compiled = compile_scope(include=["acme::Order"])
    assert matches_scope("acme::Order", compiled)
    assert not matches_scope("acme::Order\n", compiled)
