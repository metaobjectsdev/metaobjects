"""Two source-independence gates over the shared conformance corpus (ADR-0059).

Mirrors the TS reference at
server/typescript/packages/metadata/test/conformance-twin-roundtrip.test.ts.

Gate 1 -- YAML twin. Every fixture's input loads once as canonical JSON and once with
the SAME texts read as YAML sources, in the same order. JSON is valid YAML, so the
second load goes through the YAML desugar. Both loads must report the same ordered
error codes and, when clean, serialize identically. A reference means the same thing
whatever source it was written in, so any difference is a defect.

Gate 2 -- round trip. Every fixture's ``expected.json`` loads as the only input and
must serialize back to itself (trailing whitespace aside, as the corpus runner
compares). Canonical JSON is an output format, so what the serializer writes has to
load back to the same model.

Exclusions live in shared files beside the corpus, one reason per entry, so every port
skips the same fixtures for the same reasons. There are no port-local exclusions
beyond fixtures whose providers this port cannot compose.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects import MetaDataLoader
from metaobjects.errors import ParseError
from metaobjects.loader.sources import DirectorySource, InMemoryStringSource, MetaDataFormat
from metaobjects.serializer_json import canonical_serialize, canonical_serialize_effective

from .conformance_adapter import _resolve_providers
from .corpus import corpus_root
from .fixture_discovery import Fixture, discover_fixtures

_CORPUS = corpus_root()


def _read_exclusions(name: str) -> dict[str, str]:
    return json.loads((_CORPUS / name).read_text(encoding="utf-8"))["exclusions"]


_TWIN_EXCLUSIONS = _read_exclusions("yaml-twin-exclusions.json")
_ROUND_TRIP_EXCLUSIONS = _read_exclusions("round-trip-exclusions.json")


def _has_expectation(fix: Fixture) -> bool:
    # Docs-only and contract-only fixtures carry no metadata expectation: they are
    # asserted by their own runners, not by a tree comparison.
    return (
        fix.has_expected
        or fix.has_expected_effective
        or fix.has_expected_errors
        or fix.has_expected_warnings
        or fix.has_script
    )


_FIXTURES = [f for f in discover_fixtures(_CORPUS) if _has_expectation(f)]
_NAMES = {f.name for f in discover_fixtures(_CORPUS)}


def _load(sources: list[InMemoryStringSource], fix: Fixture) -> tuple[list[str], str | None, str | None] | None:
    """(ordered error codes, canonical, effective), or None when the fixture's
    providers do not compose (a provider-composition fixture: no tree to compare)."""
    try:
        loader = MetaDataLoader(providers=_resolve_providers(fix.providers), strict=True)
    except (ParseError, ValueError):
        return None
    result = loader.load(sources)
    codes = [e.code.name for e in result.errors]
    if codes:
        return codes, None, None
    return codes, canonical_serialize(result.root), canonical_serialize_effective(result.root)


def test_every_excluded_fixture_exists() -> None:
    for name in [*_TWIN_EXCLUSIONS, *_ROUND_TRIP_EXCLUSIONS]:
        assert name in _NAMES, f"exclusion names a fixture that does not exist: {name}"


_TWIN = [f for f in _FIXTURES if f.name not in _TWIN_EXCLUSIONS]


@pytest.mark.parametrize("fix", _TWIN, ids=[f.name for f in _TWIN])
def test_yaml_twin(fix: Fixture) -> None:
    files = list(DirectorySource(fix.input_dir).expand())
    texts = [f.read() for f in files]
    as_json = [InMemoryStringSource(t, id=f.id, format=f.format) for f, t in zip(files, texts)]
    # Only canonical-JSON inputs get a twin; a file already authored as YAML stays YAML.
    as_yaml = [
        InMemoryStringSource(
            t, id=f.id,
            format=MetaDataFormat.YAML if Path(f.id).suffix.lower() == ".json" else f.format,
        )
        for f, t in zip(files, texts)
    ]
    json_load = _load(as_json, fix)
    if json_load is None:
        return  # provider-composition fixture: no tree to twin
    yaml_load = _load(as_yaml, fix)
    assert yaml_load is not None
    assert yaml_load[0] == json_load[0]
    if json_load[1] is not None:
        assert yaml_load[1] == json_load[1]
        if fix.has_expected_effective:
            assert yaml_load[2] == json_load[2]


_ROUND_TRIP = [f for f in _FIXTURES if f.has_expected and f.name not in _ROUND_TRIP_EXCLUSIONS]


@pytest.mark.parametrize("fix", _ROUND_TRIP, ids=[f.name for f in _ROUND_TRIP])
def test_round_trip(fix: Fixture) -> None:
    text = (fix.dir / "expected.json").read_text(encoding="utf-8")
    loaded = _load([InMemoryStringSource(text, id="expected.json")], fix)
    if loaded is None:
        return
    assert loaded[0] == []
    # Trimmed, as the corpus runner compares goldens: a golden's trailing blank line is not content.
    assert (loaded[1] or "").strip() == text.strip()
