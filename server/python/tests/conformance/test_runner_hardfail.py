"""ADR-0023 — strict conformance runner hard-fail (Python).

A fixture that declares NO ``expected-errors.json`` but ships at least one
metadata-expectation file (``expected.json`` here) is a happy-path fixture:
under the library's strict load it MUST load with ZERO errors. Any recorded
error (e.g. ``ERR_UNKNOWN_ATTR`` from a made-up attribute) must fail the
fixture with a message naming the unexpected error(s). Mirrors the TS
reference runner.ts.
"""
from __future__ import annotations

import json
from pathlib import Path

from .fixture_discovery import Fixture
from .test_conformance import _run_checks

# A field.string with a made-up attribute no provider declares — under strict
# this produces ERR_UNKNOWN_ATTR.
_MADE_UP_INPUT = {
    "metadata.root": {
        "package": "acme::users",
        "children": [
            {
                "object.entity": {
                    "name": "Account",
                    "children": [
                        {"field.long": {"name": "id"}},
                        {"field.string": {"name": "email", "@madeUpAttr": "nope"}},
                        {"identity.primary": {"name": "pk", "@fields": ["id"]}},
                    ],
                }
            }
        ],
    }
}


def _write_happy_path_fixture(root: Path, input_obj: dict) -> Fixture:
    """Materialize a happy-path fixture (expected.json, no expected-errors.json)."""
    input_dir = root / "input"
    input_dir.mkdir(parents=True)
    (input_dir / "meta.users.json").write_text(json.dumps(input_obj))
    # A non-empty expected.json marks this as a metadata-expectation fixture.
    # Its exact bytes don't matter — the hard-fail fires before/independent of
    # the tree compare when an unexpected error is recorded.
    (root / "expected.json").write_text("{}")
    return Fixture(
        name="synthetic-made-up-attr",
        dir=root,
        input_dir=input_dir,
        providers=("metaobjects-core-types",),
        has_expected=True,
        has_expected_effective=False,
        has_expected_errors=False,
        has_expected_warnings=False,
        has_script=False,
    )


def test_happy_path_fixture_with_unexpected_error_fails(tmp_path: Path) -> None:
    """A happy-path fixture that records an error under strict must FAIL,
    and the detail must name the unexpected error code."""
    fix = _write_happy_path_fixture(tmp_path, _MADE_UP_INPUT)
    passed, detail = _run_checks(fix)
    assert not passed
    assert "ERR_UNKNOWN_ATTR" in detail


def test_clean_happy_path_fixture_passes(tmp_path: Path) -> None:
    """A happy-path fixture that loads cleanly under strict is not penalized
    by the hard-fail (it only fails the tree compare, which we don't assert)."""
    clean = {
        "metadata.root": {
            "package": "acme::users",
            "children": [
                {
                    "object.entity": {
                        "name": "Account",
                        "children": [
                            {"field.long": {"name": "id"}},
                            {"field.string": {"name": "email"}},
                            {"identity.primary": {"name": "pk", "@fields": ["id"]}},
                        ],
                    }
                }
            ],
        }
    }
    fix = _write_happy_path_fixture(tmp_path, clean)
    _, detail = _run_checks(fix)
    # The clean load produces no unexpected-error failure (a tree mismatch may
    # still be reported — assert only that the hard-fail did not fire).
    assert "unexpected error" not in detail
