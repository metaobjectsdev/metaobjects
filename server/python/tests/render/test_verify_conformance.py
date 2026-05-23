"""Verify-conformance corpus runner — the cross-language template-drift oracle.

Each fixture dir under ``fixtures/verify-conformance/`` holds a payload field-tree
(``payload.json``), a ``template.mustache``, optional ``partials/`` and
``options.json``, and an ``expected-drift.json``. The same (payload-tree +
template + options) MUST yield the same drift set here as in TS and C#.
Mirrors ``typescript/packages/render/test/verify-conformance.test.ts``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from metaobjects.render import (
    ERR_OUTPUT_TAG_MISSING,
    ERR_PARTIAL_UNRESOLVED,
    ERR_REQUIRED_SLOT_UNUSED,
    ERR_VAR_NOT_ON_PAYLOAD,
    InMemoryProvider,
    PayloadField,
    VerifyError,
    verify,
)

# The stable verify codes a fixture may legitimately expect
# (documented in fixtures/conformance/ERROR-CODES.json). Anything else is a typo.
_VERIFY_CODES = frozenset(
    {
        ERR_VAR_NOT_ON_PAYLOAD,
        ERR_PARTIAL_UNRESOLVED,
        ERR_REQUIRED_SLOT_UNUSED,
        ERR_OUTPUT_TAG_MISSING,
    }
)


def _corpus_root() -> Path:
    """Locate ``fixtures/verify-conformance`` by walking up (repo public; no hardcoded paths)."""
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        candidate = parent / "fixtures" / "verify-conformance"
        if candidate.is_dir():
            return candidate
    raise RuntimeError("could not locate fixtures/verify-conformance from " + str(here))


_CORPUS = _corpus_root()
_FIXTURES = sorted(p.name for p in _CORPUS.iterdir() if p.is_dir())


def _parse_fields(raw: Any) -> list[PayloadField]:
    """Parse the payload.json field-tree (recursive) into PayloadField[]."""
    fields: list[PayloadField] = []
    for node in raw:
        sub = node.get("fields")
        fields.append(
            PayloadField(node["name"], _parse_fields(sub) if sub is not None else None)
        )
    return fields


def _provider_from_partials(fixture_dir: Path) -> InMemoryProvider:
    partials: dict[str, str] = {}
    pdir = fixture_dir / "partials"
    if pdir.is_dir():
        for f in pdir.glob("*.mustache"):
            partials[f"partials/{f.stem}"] = f.read_text()
    return InMemoryProvider(partials)


def _key(e: VerifyError) -> tuple[str, str]:
    return (e.code, e.path)


def test_corpus_non_empty() -> None:
    assert _FIXTURES, "verify-conformance corpus is empty"


@pytest.mark.parametrize("name", _FIXTURES)
def test_verify_conformance(name: str) -> None:
    fixture_dir = _CORPUS / name
    fields = _parse_fields(json.loads((fixture_dir / "payload.json").read_text()))
    template = (fixture_dir / "template.mustache").read_text()
    expected = [
        VerifyError(e["code"], e["path"])
        for e in json.loads((fixture_dir / "expected-drift.json").read_text())
    ]

    # Lint: every expected code is a known verify code (typo guard).
    for e in expected:
        assert e.code in _VERIFY_CODES, f"unknown verify code {e.code!r}"

    # options.json (optional): requiredSlots + requiredTags + provider toggle.
    required_slots: list[str] | None = None
    required_tags: list[str] | None = None
    provider_mode: str | None = None
    options_path = fixture_dir / "options.json"
    if options_path.is_file():
        opts = json.loads(options_path.read_text())
        slots = opts.get("requiredSlots")
        if isinstance(slots, list):
            required_slots = [str(s) for s in slots]
        tags = opts.get("requiredTags")
        if isinstance(tags, list):
            required_tags = [str(s) for s in tags]
        mode = opts.get("provider")
        if isinstance(mode, str):
            provider_mode = mode

    # Provider: "with" → build from partials/ (empty if none); "without" → none.
    # Default: "with" iff a partials/ dir exists. The unresolved-partial case sets
    # provider:"with" with no partials/ dir (an empty provider resolves nothing).
    use_provider = (
        provider_mode
        if provider_mode is not None
        else ("with" if (fixture_dir / "partials").is_dir() else "without")
    )
    provider = _provider_from_partials(fixture_dir) if use_provider == "with" else None

    actual = verify(
        template,
        fields,
        provider=provider,
        required_slots=required_slots,
        required_tags=required_tags,
    )
    assert sorted(actual, key=_key) == sorted(expected, key=_key)
    # Determinism: identical across runs.
    assert (
        verify(
            template,
            fields,
            provider=provider,
            required_slots=required_slots,
            required_tags=required_tags,
        )
        == actual
    )
