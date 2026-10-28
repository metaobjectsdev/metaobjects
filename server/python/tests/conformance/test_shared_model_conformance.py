"""Runs the SERIALIZER arm of the shared publish corpus (FR-023 §4.3) in Python.

Python ships no publisher yet (Phase 2, #482, defers it until a Python-only publisher
appears), so it does not run selection, the closure check or the refusals. What it does own
is the document's bytes: load a case's ``files``, take exactly the nodes the pinned manifest
lists, and ``serialize_shared_document`` must reproduce the pinned artifact byte for byte, and
the sha256 the manifest records.

The refusal cases and the manifest's own bytes are the publisher's, and are run by
``codegen-ts/test/shared-model-conformance.test.ts`` until a second publisher exists.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from metaobjects import MetaDataLoader
from metaobjects.serializer_json import serialize_shared_document
from metaobjects.shared.base_types import TYPE_OBJECT

_CORPUS_DIR = Path(__file__).resolve().parents[4] / "fixtures" / "shared-model-conformance"
_CASES = json.loads((_CORPUS_DIR / "cases.json").read_text())["cases"]
_PUBLISHED = [c for c in _CASES if "expectArtifact" in c]


def test_corpus_is_non_empty() -> None:
    """A silent zero-case run is a failed gate, not a pass."""
    assert _PUBLISHED


@pytest.mark.parametrize("case", _PUBLISHED, ids=[c["name"] for c in _PUBLISHED])
def test_shared_document_bytes(case: dict) -> None:
    manifest = json.loads((_CORPUS_DIR / case["expectManifest"]).read_text())
    expected = (_CORPUS_DIR / case["expectArtifact"]).read_bytes()

    result = MetaDataLoader.from_uris(
        [(_CORPUS_DIR / f).as_uri() for f in case["input"]["files"]],
        strict=True,
        discover_naming=False,
    )
    assert not result.errors, [f"{e.code}: {e.message}" for e in result.errors]

    # ADR-0039 sanctioned own: the root has no super chain, so its own children are its children.
    selected = [
        c
        for c in result.root.own_children()
        if c.type == TYPE_OBJECT and c.resolution_key() in manifest["nodes"]
    ]
    assert sorted(c.resolution_key() for c in selected) == manifest["nodes"]

    document = serialize_shared_document(selected).encode("utf-8")
    assert document == expected
    assert manifest["integrity"] == "sha256-" + hashlib.sha256(document).hexdigest()
