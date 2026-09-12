"""FR-023 Task 7 — lock and manifest schemas, integrity hashing. Pure
validation and helpers only: nothing here resolves a dependency to bytes on
disk or consumes these shapes (the collection resolver is a later task). See
docs/superpowers/specs/2026-09-11-fr-023-metadata-dependencies-design.md
§3.2 (manifest), §3.3 (lock, minus `mode` — DESIGN §11.1/§11.3).
"""

import copy
from pathlib import Path

import pytest

from metaobjects.config.dependencies import sha256_integrity, validate_lock, validate_manifest
from metaobjects.errors import ErrorCode, ParseError

CORPUS = Path(__file__).resolve().parents[4] / "fixtures" / "dependency-conformance" / "artifacts"

MANIFEST = {
    "schema_version": 1,
    "name": "acme-common",
    "version": "1.0.0",
    "metamodelVersion": "1.0",
    "artifact": "acme-common.metaobjects.json",
    "integrity": "sha256-10fbf886e22faceca32c56e5e647c3ff1c82f503e638cba3bd3aa9390f7c409d",
    "packages": ["acme::common"],
    "nodes": ["acme::common::Address", "acme::common::Audited", "acme::common::Customer"],
}


def test_sha256_integrity_of_the_pinned_v1_artifact_equals_the_readme_value() -> None:
    data = (CORPUS / "acme-common-v1.json").read_bytes()
    assert sha256_integrity(data) == (
        "sha256-10fbf886e22faceca32c56e5e647c3ff1c82f503e638cba3bd3aa9390f7c409d"
    )


def test_validate_manifest_accepts_the_manifest() -> None:
    validate_manifest(copy.deepcopy(MANIFEST))


def test_validate_manifest_rejects_unsorted_nodes() -> None:
    bad = {**copy.deepcopy(MANIFEST), "nodes": ["b", "a"]}
    with pytest.raises(ParseError) as e:
        validate_manifest(bad)
    assert e.value.code == ErrorCode.ERR_DEPENDENCY_MANIFEST_INVALID
    assert "sorted" in str(e.value)


def test_validate_manifest_rejects_a_mode_key() -> None:
    bad = {**copy.deepcopy(MANIFEST), "mode": "reference"}
    with pytest.raises(ParseError) as e:
        validate_manifest(bad)
    assert e.value.code == ErrorCode.ERR_DEPENDENCY_MANIFEST_INVALID


def _entry() -> dict:
    rest = copy.deepcopy(MANIFEST)
    del rest["schema_version"]
    del rest["name"]
    rest["resolvedFrom"] = {"path": "x"}
    return rest


def test_validate_lock_accepts_one_sorted_entry() -> None:
    validate_lock({"schema_version": 1, "dependencies": {"acme-common": _entry()}})


def test_validate_lock_rejects_unsorted_keys() -> None:
    entry = _entry()
    with pytest.raises(ParseError) as e:
        validate_lock({"schema_version": 1, "dependencies": {"b": entry, "a": entry}})
    assert e.value.code == ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE
    assert "sorted" in str(e.value)


def test_validate_lock_rejects_two_transports() -> None:
    entry = _entry()
    entry["resolvedFrom"] = {"path": "x", "npm": "y"}
    with pytest.raises(ParseError) as e:
        validate_lock({"schema_version": 1, "dependencies": {"a": entry}})
    assert e.value.code == ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE


def test_validate_lock_rejects_a_mode_key() -> None:
    entry = _entry()
    entry["mode"] = "own"
    with pytest.raises(ParseError) as e:
        validate_lock({"schema_version": 1, "dependencies": {"a": entry}})
    assert e.value.code == ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE
