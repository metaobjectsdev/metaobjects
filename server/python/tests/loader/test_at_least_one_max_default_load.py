"""``validator.atLeastOne`` takes no ``@max``. The shared fixture
``error-validator-at-least-one-max-unknown`` runs under the strict loader, where the attribute is
unregistered; this runs the same input through the default (non-strict) loader, which would
otherwise keep ``@max`` and ignore it. Oracle: that fixture's ``expected-errors.json`` — exactly
one ``ERR_UNKNOWN_ATTR``, at the validator node, under either loader.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects import load_directory
from metaobjects.core_types import core_provider  # noqa: F401  — side-effect registration

_FIXTURE = (
    Path(__file__).resolve().parents[4] / "fixtures" / "conformance" / "error-validator-at-least-one-max-unknown"
)


def _expected() -> list[tuple[str, str]]:
    doc = json.loads((_FIXTURE / "expected-errors.json").read_text())
    return [(e["code"], e["source"]["jsonPath"]) for e in doc["errors"]]


@pytest.mark.parametrize("strict", [False, True])
def test_at_least_one_max_is_refused_once(strict: bool) -> None:
    result = load_directory(_FIXTURE / "input", strict=strict)
    actual = [(e.code.name, getattr(e.envelope, "json_path", None)) for e in result.errors]
    assert actual == _expected()
