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

from metaobjects.core_types import core_providers
from metaobjects.errors import MetaError
from metaobjects.loader.merge import merge_roots
from metaobjects.parser_yaml import parse_yaml
from metaobjects.provider import compose_registry
from metaobjects.serializer_json import canonical_serialize
from metaobjects.source.error_source import (
    CodeSource,
    JsonSource,
    MergedSource,
    ResolvedSource,
    YamlSource,
)
from metaobjects.super_resolve import resolve_supers
from metaobjects.loader.validation_passes import run_validations

# Full default provider set: core types + DB-domain (@column / @dbColumnType) +
# documentation + template/output domain (@xmlText). The coerced-in-string fixtures
# exercise the YAML coercion guard on the DB-domain @column attr, which only declares
# its value_type when db_provider is composed.
_PROVIDERS = list(core_providers)


def _build_yaml_envelope(err: MetaError) -> tuple[str, str, tuple[str, ...], object]:
    """Build (code, format, files, jsonPath) from a Python MetaError.

    YAML fixtures' file token is always ``"input.yaml"`` (the authoring file
    the consumer sees), not the per-port internal source id. Returns a tuple
    so the test can deep-compare envelope shapes.
    """
    code = err.code.name
    env = err.envelope
    if isinstance(env, JsonSource):
        return (code, "json", ("input.yaml",), env.json_path)
    if isinstance(env, YamlSource):
        return (code, "yaml", ("input.yaml",), env.json_path)
    if isinstance(env, MergedSource):
        return (code, "merged", tuple(env.files), env.json_path)
    if isinstance(env, ResolvedSource):
        return (code, "resolved", tuple(env.files), env.json_path)
    if isinstance(env, CodeSource):
        return (code, "code", (), None)
    return (code, "yaml", ("input.yaml",), "$")


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

# FR5a envelope-shape gates — sourced from a sibling ledger file (matching the
# C# / Java pattern). Each entry is a known cross-port drift where Python's
# emitted source field differs from TS's (the FR5a reference port) by more
# than the jsonPath alone. The code-set check still runs; only the full-envelope
# assertion is skipped. Reconcile per the FR5a follow-up.
_LEDGER_PATH = Path(__file__).parent / "yaml-conformance-expected-failures.json"
_FR5A_ENVELOPE_DRIFT_FIXTURES = (
    set(json.loads(_LEDGER_PATH.read_text(encoding="utf-8")).get("fixtures", []))
    if _LEDGER_PATH.exists()
    else set()
)


def _load_yaml_to_canonical(yaml_text: str) -> tuple[str, list[str], list[MetaError], list[str]]:
    """Drive the YAML file through the same loader pipeline used by JSON:
    parse_yaml -> merge_roots -> resolve_supers -> run_validations.

    Returns (canonical_serialization, error_codes, error_objects, warnings).
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
    return canonical, codes, errors, warnings


@pytest.mark.parametrize("fix", _FIXTURES, ids=[f.name for f in _FIXTURES])
def test_yaml_conformance(fix: YamlFixture) -> None:
    yaml_text = (fix.dir / "input.yaml").read_text(encoding="utf-8")
    canonical, codes, error_objs, _warnings = _load_yaml_to_canonical(yaml_text)

    if fix.has_expected_errors:
        raw = json.loads((fix.dir / "expected-errors.json").read_text())
        # Accept both legacy and FR5a envelope shapes.
        if isinstance(raw, list):
            expected_errors = [{"code": e["code"], "source": None} for e in raw]
            legacy = True
        elif isinstance(raw, dict) and isinstance(raw.get("errors"), list):
            expected_errors = [
                {"code": e["code"],
                 "source": e["source"] if isinstance(e.get("source"), dict) else None}
                for e in raw["errors"]
            ]
            legacy = False
        else:
            raise AssertionError(
                f"{fix.name}: expected-errors.json must be a legacy array or FR5a envelope object")

        # Code-set check (deduplicated, sorted — matches TS YAML semantics).
        want = sorted({e["code"] for e in expected_errors})
        got = sorted(set(codes))
        assert got == want, (
            f"{fix.name}: expected error codes {want} but got {got}"
        )

        # FR5a — per-error envelope assertion (in declaration order). Skipped for
        # fixtures listed as known cross-port drift in
        # ``_FR5A_ENVELOPE_DRIFT_FIXTURES``; the code-set check above still runs.
        if not legacy and fix.name not in _FR5A_ENVELOPE_DRIFT_FIXTURES:
            envelopes = [_build_yaml_envelope(e) for e in error_objs]
            assert len(expected_errors) == len(envelopes), (
                f"{fix.name}: envelope length mismatch: expected {len(expected_errors)}, "
                f"got {len(envelopes)}"
            )
            for i, (w, g) in enumerate(zip(expected_errors, envelopes)):
                g_code, g_format, g_files, g_path = g
                assert w["code"] == g_code, (
                    f"{fix.name}: envelope[{i}].code: expected '{w['code']}', got '{g_code}'")
                src = w["source"]
                if src is None:
                    continue
                assert src["format"] == g_format, (
                    f"{fix.name}: envelope[{i}].source.format: expected '{src['format']}', got '{g_format}'")
                want_files = tuple(src["files"])
                assert want_files == g_files, (
                    f"{fix.name}: envelope[{i}].source.files: expected {list(want_files)}, "
                    f"got {list(g_files)}")
                want_path = src.get("jsonPath")
                if want_path is not None:
                    assert want_path == g_path, (
                        f"{fix.name}: envelope[{i}].source.jsonPath: expected '{want_path}', "
                        f"got '{g_path}'")
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
