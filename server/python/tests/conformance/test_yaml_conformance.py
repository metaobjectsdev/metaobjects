"""YAML conformance runner over the shared fixtures/yaml-conformance/ corpus.

Mirrors the TS reference at
server/typescript/packages/metadata/test/yaml-conformance.test.ts.

Each fixture directory under fixtures/yaml-conformance/ contains:
  - input.yaml                                       (required)
  - expected.json          (happy-path -> canonical serialization must match)
  - expected-errors.json   (error-path -> emitted ERR_* codes must match)

Exactly one of expected.json / expected-errors.json must be present per
fixture. Adding a directory adds one parametrized test automatically.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import pytest

from metaobjects.core_types import core_provider
from metaobjects.documentation import doc_provider
from metaobjects.errors import MetaError
from metaobjects.loader.merge import merge_roots
from metaobjects.parser_yaml import parse_yaml
from metaobjects.provider import compose_registry
from metaobjects.serializer_json import canonical_serialize
from metaobjects.super_resolve import resolve_supers
from metaobjects.loader.validation_passes import run_validations

_PROVIDERS = [core_provider, doc_provider]


@dataclass(frozen=True)
class YamlFixture:
    name: str
    dir: Path
    has_expected: bool
    has_expected_errors: bool


def _yaml_corpus_root() -> Path:
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        candidate = parent / "fixtures" / "yaml-conformance"
        if candidate.is_dir():
            return candidate
    raise RuntimeError("could not locate fixtures/yaml-conformance from " + str(here))


def _discover() -> list[YamlFixture]:
    corpus = _yaml_corpus_root()
    fixtures: list[YamlFixture] = []
    for entry in sorted(p for p in corpus.iterdir() if p.is_dir()):
        has_expected = (entry / "expected.json").is_file()
        has_expected_errors = (entry / "expected-errors.json").is_file()
        if has_expected and has_expected_errors:
            raise RuntimeError(
                f"Fixture '{entry.name}' has both expected.json and "
                f"expected-errors.json - one only."
            )
        if not has_expected and not has_expected_errors:
            raise RuntimeError(
                f"Fixture '{entry.name}' has neither expected.json nor "
                f"expected-errors.json."
            )
        fixtures.append(YamlFixture(
            name=entry.name,
            dir=entry,
            has_expected=has_expected,
            has_expected_errors=has_expected_errors,
        ))
    return fixtures


_FIXTURES = _discover()


def _load_yaml_to_canonical(yaml_text: str) -> tuple[str, list[str], list[str]]:
    """Drive the YAML file through the same loader pipeline used by JSON:
    parse_yaml -> merge_roots -> resolve_supers -> run_validations.

    Returns (canonical_serialization, error_codes, warnings).
    """
    registry = compose_registry(_PROVIDERS)
    errors: list[MetaError] = []
    warnings: list[str] = []

    parse_result = parse_yaml(yaml_text, registry, source="input.yaml")
    errors.extend(parse_result.errors)
    warnings.extend(parse_result.warnings)

    root = parse_result.root
    if not parse_result.errors:
        root = merge_roots([parse_result.root], errors)
        resolve_supers(root, errors)

    run_validations(root, registry, errors, warnings)
    root.freeze()

    canonical = canonical_serialize(root)
    codes = [e.code.name for e in errors]
    return canonical, codes, warnings


@pytest.mark.parametrize("fix", _FIXTURES, ids=[f.name for f in _FIXTURES])
def test_yaml_conformance(fix: YamlFixture) -> None:
    yaml_text = (fix.dir / "input.yaml").read_text(encoding="utf-8")
    canonical, codes, _warnings = _load_yaml_to_canonical(yaml_text)

    if fix.has_expected_errors:
        # Error-path: deduplicated, sorted ERR_* code set match (mirrors TS).
        raw = json.loads((fix.dir / "expected-errors.json").read_text())
        want = sorted({entry["code"] for entry in raw})
        got = sorted(set(codes))
        assert got == want, (
            f"{fix.name}: expected error codes {want} but got {got}"
        )
    else:
        # Happy-path: zero errors and canonical serialization must match.
        assert codes == [], (
            f"{fix.name}: expected no errors but got {codes}"
        )
        # Byte-compare per the canonical-serializer contract
        # (spec/conformance-tests.md): 2-space indent, sorted @-attrs,
        # declaration-ordered children, trailing newline are ALL part of the
        # cross-port contract. A tree compare would silently pass regressions
        # in any of these. Trim only the trailing newline so authors don't
        # have to fight editors-that-trim. TS does `expect(got).toBe(want)`;
        # C# + Java do trimmed-string compare. Python now matches.
        want = (fix.dir / "expected.json").read_text(encoding="utf-8")
        assert canonical.strip() == want.strip(), (
            f"{fix.name}: canonical byte mismatch\n"
            f"--- want ---\n{want}\n"
            f"--- got ---\n{canonical}"
        )
