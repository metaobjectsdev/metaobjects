"""Runs the shared publish corpus (FR-023 §4.3) in Python: every case of
``fixtures/shared-model-conformance`` through the same ``build_shared_model`` and
``render_shared_model_files`` the ``shared-model`` generator calls.

A publish case must reproduce the pinned artifact byte for byte and the pinned manifest (the
golden carries ``@@METAMODEL_VERSION@@``, replaced here by this port's constant); a refusal case
must raise the pinned reason and, for ``not-closed``, exactly the pinned ``(referrer, target)``
pairs. The message text is not the contract.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from metaobjects.provider import Provider
from metaobjects.registry import AttrSchema, TypeRegistry
from metaobjects.registry_manifest import METAMODEL_VERSION
from metaobjects.shared_model import (
    SharedModelError,
    build_shared_model,
    render_shared_model_files,
)

_CORPUS_DIR = Path(__file__).resolve().parents[4] / "fixtures" / "shared-model-conformance"
_CASES = json.loads((_CORPUS_DIR / "cases.json").read_text())["cases"]
_PUBLISHED = [c for c in _CASES if "expectArtifact" in c]
_REFUSED = [c for c in _CASES if "expectRefusal" in c]


class _SecretHandling(Provider):
    """The corpus's test provider ``secret-handling``: one common string attribute, which is
    vocabulary a consumer's core-only toolchain does not have."""

    def __init__(self) -> None:
        super().__init__("secret-handling", dependencies=())

    def register_types(self, registry: TypeRegistry) -> None:  # noqa: D401
        registry.register_common_attrs([AttrSchema("secretHandling", "string")])


_PROVIDERS = {"secret-handling": _SecretHandling}


def _build(case: dict):
    spec = case["input"]
    return build_shared_model(
        spec["name"],
        [_CORPUS_DIR / f for f in spec["files"]],
        spec.get("include", []),
        spec.get("exclude", []),
        requirements=spec.get("requirements", False),
        providers=[_PROVIDERS[p]() for p in spec.get("providers", [])],
    )


def test_corpus_is_non_empty() -> None:
    """A silent zero-case run is a failed gate, not a pass."""
    assert len(_PUBLISHED) == 9
    assert len(_REFUSED) == 6
    assert len(_CASES) == len(_PUBLISHED) + len(_REFUSED)


@pytest.mark.parametrize("case", _PUBLISHED, ids=[c["name"] for c in _PUBLISHED])
def test_published_artifact_and_manifest_bytes(case: dict) -> None:
    expected_artifact = (_CORPUS_DIR / case["expectArtifact"]).read_text()
    expected_manifest = (_CORPUS_DIR / case["expectManifest"]).read_text().replace(
        "@@METAMODEL_VERSION@@", METAMODEL_VERSION
    )

    files = render_shared_model_files(_build(case), case["input"]["version"])

    assert files.artifact[0] == f"{case['input']['name']}.metaobjects.json"
    assert files.artifact[1] == expected_artifact
    assert files.manifest[0] == "metaobjects.pkg.json"
    assert files.manifest[1] == expected_manifest
    manifest = json.loads(files.manifest[1])
    assert manifest["integrity"] == "sha256-" + hashlib.sha256(files.artifact[1].encode()).hexdigest()


@pytest.mark.parametrize("case", _REFUSED, ids=[c["name"] for c in _REFUSED])
def test_refusals(case: dict) -> None:
    expected = case["expectRefusal"]
    with pytest.raises(SharedModelError) as raised:
        _build(case)
    assert raised.value.reason == expected["reason"]
    if expected["reason"] == "not-closed":
        assert [
            {"referrer": r, "target": t} for r, t in raised.value.pairs
        ] == expected["pairs"]
