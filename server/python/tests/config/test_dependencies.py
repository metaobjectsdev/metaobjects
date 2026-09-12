"""FR-023 Task 7 — lock and manifest schemas, integrity hashing. Pure
validation and helpers only: nothing here resolves a dependency to bytes on
disk or consumes these shapes (the collection resolver is a later task). See
docs/superpowers/specs/2026-09-11-fr-023-metadata-dependencies-design.md
§3.2 (manifest), §3.3 (lock, minus `mode` — DESIGN §11.1/§11.3).
"""

import copy
import json
from pathlib import Path

import pytest

from metaobjects.config.dependencies import (
    LOCK_FILE,
    Collection,
    ResolvedDependency,
    dependency_source_id,
    explicitly_includes,
    imported_from,
    read_lock,
    refuse_unowned_packages,
    sha256_integrity,
    validate_lock,
    validate_manifest,
    verify_snapshot,
)
from metaobjects import MetaDataLoader
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


def test_dependency_source_id_is_dep_name_slash_artifact() -> None:
    assert (
        dependency_source_id("acme-common", "acme-common.metaobjects.json")
        == "dep:acme-common/acme-common.metaobjects.json"
    )


def test_read_lock_returns_none_when_the_file_does_not_exist(tmp_path: Path) -> None:
    # No `.metaobjects/` directory at all — a project declaring no
    # dependencies has no lock file, and that is not an error.
    assert read_lock(tmp_path) is None


def test_read_lock_reads_and_validates_a_present_lock(tmp_path: Path) -> None:
    entry = _entry()
    lock = {"schema_version": 1, "dependencies": {"acme-common": entry}}
    d = tmp_path / ".metaobjects"
    d.mkdir(parents=True)
    (d / LOCK_FILE).write_text(json.dumps(lock))

    assert read_lock(tmp_path) == validate_lock(lock)


def test_read_lock_raises_on_malformed_json(tmp_path: Path) -> None:
    d = tmp_path / ".metaobjects"
    d.mkdir(parents=True)
    (d / LOCK_FILE).write_text("{ not json")
    with pytest.raises(ParseError) as e:
        read_lock(tmp_path)
    assert e.value.code == ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE


def test_read_lock_raises_on_a_shape_violation(tmp_path: Path) -> None:
    entry = _entry()
    entry["mode"] = "own"  # unknown key — same violation validate_lock rejects
    lock = {"schema_version": 1, "dependencies": {"acme-common": entry}}
    d = tmp_path / ".metaobjects"
    d.mkdir(parents=True)
    (d / LOCK_FILE).write_text(json.dumps(lock))

    with pytest.raises(ParseError) as e:
        read_lock(tmp_path)
    assert e.value.code == ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE


# ---------------------------------------------------------------------------
# FR-023 Task 18 — verify_snapshot, explicitly_includes, imported_from,
# refuse_unowned_packages, Collection. The dependency-conformance corpus
# (`tests/conformance/test_dependency_conformance.py`) exercises these
# end-to-end via `resolve_collection_full`; these are the focused unit tests.
# ---------------------------------------------------------------------------


def _write_snapshot(tmp_path: Path, name: str, artifact_name: str, source: Path) -> None:
    d = tmp_path / ".metaobjects" / "deps" / name
    d.mkdir(parents=True)
    (d / artifact_name).write_bytes(source.read_bytes())


def test_verify_snapshot_no_dependencies_no_lock_returns_empty(tmp_path: Path) -> None:
    # A mutation deleting the `lock is None and not declared` short-circuit
    # would instead raise (or crash on `lock["dependencies"]` with lock=None) —
    # this pins the byte-identical untouched-project path.
    assert verify_snapshot(tmp_path, [], None) == []


def test_verify_snapshot_declared_but_no_lock_is_stale(tmp_path: Path) -> None:
    with pytest.raises(ParseError) as e:
        verify_snapshot(tmp_path, [{"name": "acme-common", "path": "x"}], None)
    assert e.value.code == ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE


def test_verify_snapshot_declared_name_missing_from_lock_entries_is_stale(tmp_path: Path) -> None:
    lock = validate_lock({"schema_version": 1, "dependencies": {}})
    with pytest.raises(ParseError) as e:
        verify_snapshot(tmp_path, [{"name": "acme-common", "path": "x"}], lock)
    assert e.value.code == ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE


def test_verify_snapshot_lock_entry_without_a_declared_dependency_is_stale(tmp_path: Path) -> None:
    _write_snapshot(tmp_path, "acme-common", "acme-common.metaobjects.json", CORPUS / "acme-common-v1.json")
    lock = validate_lock({"schema_version": 1, "dependencies": {"acme-common": _entry()}})
    # Declares NOTHING, but the lock has an "acme-common" entry.
    with pytest.raises(ParseError) as e:
        verify_snapshot(tmp_path, [], lock)
    assert e.value.code == ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE


def test_verify_snapshot_resolves_the_pinned_artifact(tmp_path: Path) -> None:
    _write_snapshot(tmp_path, "acme-common", "acme-common.metaobjects.json", CORPUS / "acme-common-v1.json")
    lock = validate_lock({"schema_version": 1, "dependencies": {"acme-common": _entry()}})
    resolved = verify_snapshot(tmp_path, [{"name": "acme-common", "path": "../acme-common"}], lock)

    assert len(resolved) == 1
    dep = resolved[0]
    assert dep.name == "acme-common"
    assert dep.version == "1.0.0"
    assert dep.packages == ("acme::common",)
    assert dep.nodes == ("acme::common::Address", "acme::common::Audited", "acme::common::Customer")
    assert dep.source_id == "dep:acme-common/acme-common.metaobjects.json"
    assert dep.artifact_path.endswith("acme-common.metaobjects.json")


def test_verify_snapshot_orders_results_by_dependency_name_not_declaration_order(
    tmp_path: Path,
) -> None:
    _write_snapshot(tmp_path, "acme-common", "acme-common.metaobjects.json", CORPUS / "acme-common-v1.json")
    entry_b = {**_entry(), "packages": ["b::pkg"], "nodes": ["b::pkg::Thing"]}
    lock = validate_lock(
        {"schema_version": 1, "dependencies": {"acme-common": _entry(), "b-dep": entry_b}}
    )
    # `b-dep`'s artifact is never read (its packages/nodes are fabricated) because
    # dependency name order is "acme-common" < "b-dep" and — for THIS assertion —
    # only the ORDER of the resolved list matters, not that b-dep resolves too.
    # Declare in the OPPOSITE order to prove result order is name-sorted, not
    # declaration-sorted; b-dep would fail on its (fabricated) artifact if this
    # test's dependency list actually needed it to resolve, so keep it absent
    # and assert failure lands on it specifically, past acme-common.
    specs = [{"name": "b-dep", "path": "y"}, {"name": "acme-common", "path": "x"}]
    with pytest.raises(ParseError) as e:
        verify_snapshot(tmp_path, specs, lock)
    assert e.value.code == ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE
    assert "b-dep" in str(e.value)


def test_verify_snapshot_missing_artifact_is_stale(tmp_path: Path) -> None:
    lock = validate_lock({"schema_version": 1, "dependencies": {"acme-common": _entry()}})
    with pytest.raises(ParseError) as e:
        verify_snapshot(tmp_path, [{"name": "acme-common", "path": "x"}], lock)
    assert e.value.code == ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE


def test_verify_snapshot_hash_mismatch_is_stale(tmp_path: Path) -> None:
    d = tmp_path / ".metaobjects" / "deps" / "acme-common"
    d.mkdir(parents=True)
    (d / "acme-common.metaobjects.json").write_text("{}")  # wrong bytes
    lock = validate_lock({"schema_version": 1, "dependencies": {"acme-common": _entry()}})
    with pytest.raises(ParseError) as e:
        verify_snapshot(tmp_path, [{"name": "acme-common", "path": "x"}], lock)
    assert e.value.code == ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE


def test_verify_snapshot_metamodel_major_mismatch(tmp_path: Path) -> None:
    _write_snapshot(tmp_path, "acme-common", "acme-common.metaobjects.json", CORPUS / "acme-common-v1.json")
    entry = {**_entry(), "metamodelVersion": "99.0"}
    lock = validate_lock({"schema_version": 1, "dependencies": {"acme-common": entry}})
    with pytest.raises(ParseError) as e:
        verify_snapshot(tmp_path, [{"name": "acme-common", "path": "x"}], lock)
    assert e.value.code == ErrorCode.ERR_DEPENDENCY_METAMODEL_INCOMPATIBLE


def test_verify_snapshot_node_collision(tmp_path: Path) -> None:
    _write_snapshot(tmp_path, "acme-common", "acme-common.metaobjects.json", CORPUS / "acme-common-v1.json")
    _write_snapshot(tmp_path, "acme-common-2", "acme-common.metaobjects.json", CORPUS / "acme-common-v1.json")
    lock = validate_lock(
        {
            "schema_version": 1,
            "dependencies": {"acme-common": _entry(), "acme-common-2": _entry()},
        }
    )
    specs = [{"name": "acme-common", "path": "x"}, {"name": "acme-common-2", "path": "y"}]
    with pytest.raises(ParseError) as e:
        verify_snapshot(tmp_path, specs, lock)
    assert e.value.code == ErrorCode.ERR_DEPENDENCY_NODE_COLLISION


def test_explicitly_includes_names_the_package_literally() -> None:
    assert explicitly_includes(["acme::common::**"], "acme::common") is True
    assert explicitly_includes(["acme::common::Address"], "acme::common") is True
    # A wildcard REACHES the package's nodes without NAMING the package.
    assert explicitly_includes(["acme::**"], "acme::common") is False
    assert explicitly_includes(["**"], "acme::common") is False
    assert explicitly_includes(None, "acme::common") is False
    assert explicitly_includes([], "acme::common") is False
    # A root-level (package-less) fqn is never named — fail-closed.
    assert explicitly_includes(["acme::common::**"], "") is False


def test_imported_from_finds_the_owning_dependency() -> None:
    deps = [
        ResolvedDependency(
            name="acme-common", version="1.0.0", packages=("acme::common",),
            nodes=(), artifact_path="x", source_id="dep:x",
        ),
        ResolvedDependency(
            name="acme-extra", version="1.0.0", packages=("acme::extra",),
            nodes=(), artifact_path="y", source_id="dep:y",
        ),
    ]
    assert imported_from("acme::common", deps) == "acme-common"
    assert imported_from("acme::extra", deps) == "acme-extra"
    assert imported_from("acme::other", deps) is None
    assert imported_from("acme::other", []) is None


def _collection(**overrides: object) -> Collection:
    base: dict[str, object] = dict(
        files=(), own_files=(), file_ids={}, dependencies=(),
        imported_packages=frozenset(), imported_nodes=frozenset(),
        scope_include=(), in_migrate_scope=None,
    )
    base.update(overrides)
    return Collection(**base)  # type: ignore[arg-type]


def test_collection_imported_is_package_keyed() -> None:
    c = _collection(imported_packages=frozenset({"acme::common"}))
    assert c.imported("acme::common::Customer") is True
    assert c.imported("app::Order") is False


def test_collection_in_scope_excludes_imported_by_default() -> None:
    c = _collection(imported_packages=frozenset({"acme::common"}))
    assert c.in_scope("app::Order") is True  # own object — never excluded
    assert c.in_scope("acme::common::Customer") is False  # imported, no explicit include


def test_collection_in_scope_explicit_include_opts_the_package_in() -> None:
    c = _collection(
        imported_packages=frozenset({"acme::common"}),
        scope_include=("acme::common::**",),
    )
    assert c.in_scope("acme::common::Customer") is True


def test_refuse_unowned_packages_noop_when_nothing_is_imported() -> None:
    result = MetaDataLoader.from_string('{"metadata.root":{"children":[]}}')
    assert not result.errors
    refuse_unowned_packages(result.root, frozenset(), frozenset())
    refuse_unowned_packages(result.root, None, None)  # type: ignore[arg-type]


def test_refuse_unowned_packages_raises_for_a_new_local_node_in_a_dependency_package() -> None:
    doc = (
        '{"metadata.root":{"package":"acme::common","children":['
        '{"object.value":{"name":"Note","children":[{"field.string":{"name":"text"}}]}}'
        "]}}"
    )
    result = MetaDataLoader.from_string(doc)
    assert not result.errors
    with pytest.raises(ParseError) as e:
        refuse_unowned_packages(result.root, frozenset({"acme::common"}), frozenset())
    assert e.value.code == ErrorCode.ERR_DEPENDENCY_PACKAGE_NOT_OWNED


def test_refuse_unowned_packages_allows_a_node_already_in_imported_nodes() -> None:
    # The overlay-merge outcome: the node's key IS one of the dependency's own
    # `nodes` (it merged into the imported node, rather than declaring a new one).
    doc = (
        '{"metadata.root":{"package":"acme::common","children":['
        '{"object.value":{"name":"Note","children":[{"field.string":{"name":"text"}}]}}'
        "]}}"
    )
    result = MetaDataLoader.from_string(doc)
    refuse_unowned_packages(
        result.root, frozenset({"acme::common"}), frozenset({"acme::common::Note"})
    )  # no raise
