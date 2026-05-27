"""Discover conformance scenario directories, sorted by name, with expectation-file flags."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

# Default provider id list when a fixture omits providers.json (parity with
# the C# adapter's FixtureDiscovery.DefaultProviders).
_DEFAULT_PROVIDERS: tuple[str, ...] = ("metaobjects-core-types",)


@dataclass(frozen=True)
class Fixture:
    name: str
    dir: Path
    input_dir: Path
    providers: tuple[str, ...]
    has_expected: bool
    has_expected_errors: bool
    has_expected_warnings: bool
    has_script: bool


def discover_fixtures(corpus: Path) -> list[Fixture]:
    fixtures: list[Fixture] = []
    for entry in sorted(p for p in corpus.iterdir() if p.is_dir()):
        input_dir = entry / "input"
        if not input_dir.is_dir():
            continue  # CAPABILITIES.json etc. are files, not fixtures

        # Read providers.json if present; else default to core types only.
        # Mirrors the C# FixtureDiscovery shape so all three ports honor the
        # fixture's declared provider set.
        providers_path = entry / "providers.json"
        if providers_path.is_file():
            raw = json.loads(providers_path.read_text())
            if not isinstance(raw, list) or not all(isinstance(p, str) for p in raw):
                raise ValueError(
                    f"Fixture '{entry.name}': providers.json must be a JSON array of strings"
                )
            providers = tuple(raw)
        else:
            providers = _DEFAULT_PROVIDERS

        fixtures.append(
            Fixture(
                name=entry.name,
                dir=entry,
                input_dir=input_dir,
                providers=providers,
                has_expected=(entry / "expected.json").is_file(),
                has_expected_errors=(entry / "expected-errors.json").is_file(),
                has_expected_warnings=(entry / "expected-warnings.json").is_file(),
                has_script=(entry / "script.json").is_file(),
            )
        )
    return fixtures
