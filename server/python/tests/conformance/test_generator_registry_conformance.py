"""Conformance: the Python generator registry vs the canonical stable-name manifest.

ADR-0021 D3. ``fixtures/generator-registry-conformance/registry.json`` is the
single cross-port source of truth for generator stable names. This test asserts
that the Python ``GENERATOR_REGISTRY`` exposes EXACTLY the set of stable names
whose manifest ``ports`` array includes ``python`` — no extras, none missing —
and that every Python entry's tier agrees with the manifest.

If this fails, the registry and the manifest disagree. The manifest is canonical:
do NOT edit it to make this pass — fix the Python registry (or report the diff).
"""
from __future__ import annotations

import json
from pathlib import Path

from metaobjects.codegen.generator_registry import GENERATOR_REGISTRY

PORT = "python"


def _find_manifest() -> Path:
    """Walk up to the repo root (the dir holding both ``fixtures/`` and ``server/``)."""
    p = Path(__file__).resolve()
    while p != p.parent:
        if (p / "fixtures").is_dir() and (p / "server").is_dir():
            manifest = p / "fixtures" / "generator-registry-conformance" / "registry.json"
            if manifest.is_file():
                return manifest
        p = p.parent
    raise RuntimeError(
        "fixtures/generator-registry-conformance/registry.json not found "
        "(walked up looking for a dir containing both fixtures/ and server/)"
    )


def _manifest_python_slice() -> dict[str, dict]:
    manifest = json.loads(_find_manifest().read_text())
    generators = manifest["generators"]
    return {
        name: spec
        for name, spec in generators.items()
        if PORT in spec.get("ports", [])
    }


def test_registry_name_set_equals_manifest_python_slice() -> None:
    expected = set(_manifest_python_slice().keys())
    actual = set(GENERATOR_REGISTRY.keys())

    extras = sorted(actual - expected)
    missing = sorted(expected - actual)

    assert actual == expected, (
        "Python GENERATOR_REGISTRY disagrees with the canonical manifest "
        "(fixtures/generator-registry-conformance/registry.json).\n"
        f"  extras (in registry, NOT expected for python): {extras}\n"
        f"  missing (expected for python, NOT in registry): {missing}\n"
        "The manifest is canonical — fix the registry, do NOT edit the manifest."
    )


def test_registry_tiers_agree_with_manifest() -> None:
    py_slice = _manifest_python_slice()
    mismatches = []
    for name, spec in py_slice.items():
        if name not in GENERATOR_REGISTRY:
            continue  # name-set test reports this
        expected_tier = spec["tier"]
        actual_tier = GENERATOR_REGISTRY[name].tier
        if actual_tier != expected_tier:
            mismatches.append(
                f"{name}: registry tier={actual_tier!r} != manifest tier={expected_tier!r}"
            )
    assert not mismatches, "tier disagreement vs manifest:\n  " + "\n  ".join(mismatches)


def test_registry_python_slice_is_all_native() -> None:
    # The Python slice of the manifest is entirely tier: native.
    assert all(e.tier == "native" for e in GENERATOR_REGISTRY.values()), (
        "Every Python registry entry must be tier 'native'; found: "
        + ", ".join(f"{k}={v.tier}" for k, v in GENERATOR_REGISTRY.items() if v.tier != "native")
    )


def test_registry_factories_construct_without_throwing() -> None:
    # Each registered factory must build a Generator (with a .name) without raising.
    for name, entry in GENERATOR_REGISTRY.items():
        gen = entry.factory()
        assert hasattr(gen, "name"), f"{name}: factory produced a non-Generator"
