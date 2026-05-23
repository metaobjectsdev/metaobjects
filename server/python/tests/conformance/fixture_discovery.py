"""Discover conformance scenario directories, sorted by name, with expectation-file flags."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Fixture:
    name: str
    dir: Path
    input_dir: Path
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
        fixtures.append(
            Fixture(
                name=entry.name,
                dir=entry,
                input_dir=input_dir,
                has_expected=(entry / "expected.json").is_file(),
                has_expected_errors=(entry / "expected-errors.json").is_file(),
                has_expected_warnings=(entry / "expected-warnings.json").is_file(),
                has_script=(entry / "script.json").is_file(),
            )
        )
    return fixtures
