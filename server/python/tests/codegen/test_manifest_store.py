"""ADR-0064 Amendment 1: the hash manifest is one file per model package.

Runs the shared vectors (``fixtures/codegen-skip-conformance/manifests.json``) against the
Python manifest store, plus the file-level separation, the read-only guarantee and an end-to-end
multi-package ``gen``.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from metaobjects.cli import main
from metaobjects.codegen import overwrite_policy as op
from metaobjects.codegen.overwrite_policy import (
    HashManifest,
    has_hash_manifest,
    package_file_name,
    place_entry,
    set_placement_objects,
)
from tests.codegen.config_helpers import as_config
from tests.codegen.gen_suite import GEN_SUITE
from tests.codegen.manifest_helpers import manifest_files, read_manifest

VECTORS = json.loads(
    (Path(__file__).parents[4] / "fixtures" / "codegen-skip-conformance" / "manifests.json").read_text()
)
OBJECTS = [(o["name"], o["package"]) for o in VECTORS["objects"]]


@pytest.mark.parametrize("case", VECTORS["fileNames"], ids=lambda c: c["file"])
def test_file_names(case: dict) -> None:
    assert package_file_name(case["package"]) == case["file"]


@pytest.mark.parametrize("case", VECTORS["placement"], ids=lambda c: f'{c["path"]}->{c["package"]}')
def test_placement(case: dict) -> None:
    entry = case.get("entry", "h")
    package = place_entry(case["path"], entry, OBJECTS)
    assert package == case["package"]


def _state(tmp_path: Path) -> Path:
    state = tmp_path / ".metaobjects" / ".gen-state"
    state.mkdir(parents=True)
    return state


def test_legacy_split(tmp_path: Path) -> None:
    split = VECTORS["legacySplit"]
    state = _state(tmp_path)
    gitignore = state.parent / ".gitignore"
    gitignore.write_text(split["gitignoreBefore"])
    (state / ".hashes.json").write_text(json.dumps(split["legacy"]))
    set_placement_objects(str(state), OBJECTS)

    session = HashManifest(str(state))
    assert session.dirty, "a run that finds a legacy manifest always saves"
    session.save()

    assert {n: c for n, c in manifest_files(state).items()} == split["files"]
    assert (state / ".hashes" / split["goldenFile"]).read_text() == split["goldenText"]
    assert not (state / ".hashes.json").exists()
    assert gitignore.read_text() == split["gitignoreAfter"]

    before = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in (state / ".hashes").glob("*.json")}
    again = HashManifest(str(state))
    assert not again.dirty
    again.dirty = True
    again.save()
    after = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in (state / ".hashes").glob("*.json")}
    assert after == before, "a second identical write changes no file"


def test_different_packages_different_files(tmp_path: Path) -> None:
    state = _state(tmp_path)
    set_placement_objects(str(state), OBJECTS)
    m = HashManifest(str(state))
    m.record("gen/Order.ts", "a")
    m.record("gen/Customer.ts", "b")
    m.record("gen/index.ts", "c")
    m.save()
    files = manifest_files(state)
    assert sorted(files) == [".root.json", "acme.crm.json", "acme.shop.json"]

    paths = {n: state / ".hashes" / n for n in files}
    for p in paths.values():
        os.utime(p, (1, 1))
    crm_bytes = paths["acme.crm.json"].read_bytes()

    m = HashManifest(str(state))
    m.record("gen/Order.ts", "changed")  # package A only
    m.save()
    assert paths["acme.shop.json"].stat().st_mtime != 1
    assert paths["acme.crm.json"].stat().st_mtime == 1
    assert paths[".root.json"].stat().st_mtime == 1
    assert paths["acme.crm.json"].read_bytes() == crm_bytes

    # A no-op save writes nothing: recording identical content again keeps the session
    # clean, and a save changes no file's bytes or mtime.
    for p in paths.values():
        os.utime(p, (2, 2))
    before = {n: p.read_bytes() for n, p in paths.items()}
    m = HashManifest(str(state))
    m.record("gen/Order.ts", "changed")  # identical to what the last save recorded
    m.record("gen/Customer.ts", "b")
    m.record("gen/index.ts", "c")
    assert not m.dirty, "an unchanged re-record must keep the session clean"
    assert m.save() is False
    assert {n: p.read_bytes() for n, p in paths.items()} == before
    assert all(p.stat().st_mtime == 2 for p in paths.values())

    # Removing a package's last entry deletes its file.
    raw = read_manifest(state)
    del raw["gen/Customer.ts"]
    op._save_hashes(str(state), {k: op._entry_hash(v) or "" for k, v in raw.items()})
    assert not paths["acme.crm.json"].exists()
    assert paths["acme.shop.json"].exists()


def test_empty_manifest_keeps_the_root_file(tmp_path: Path) -> None:
    state = _state(tmp_path)
    set_placement_objects(str(state), OBJECTS)
    m = HashManifest(str(state))
    m.record("gen/Order.ts", "a")
    m.save()
    op._save_hashes(str(state), {})
    assert manifest_files(state) == {".root.json": {}}
    assert has_hash_manifest(str(state))


def test_read_only_load_migrates_nothing(tmp_path: Path) -> None:
    state = _state(tmp_path)
    legacy = state / ".hashes.json"
    legacy.write_text(json.dumps({"gen/Order.ts": "h1"}))
    os.utime(legacy, (1, 1))
    assert has_hash_manifest(str(state))
    assert op.read_generated_hash(str(state), "gen/Order.ts") == "h1"
    assert legacy.read_bytes() == json.dumps({"gen/Order.ts": "h1"}).encode()
    assert legacy.stat().st_mtime == 1
    assert not (state / ".hashes").exists()


def test_union_prefers_package_files_over_the_legacy_file(tmp_path: Path) -> None:
    state = _state(tmp_path)
    (state / ".hashes").mkdir()
    (state / ".hashes.json").write_text(json.dumps({"a": "old", "b": "legacy"}))
    (state / ".hashes" / "x.json").write_text(json.dumps({"a": "new"}))
    assert op.read_generated_hash(str(state), "a") == "new"
    assert op.read_generated_hash(str(state), "b") == "legacy"


def test_gen_on_a_multi_package_model_writes_one_manifest_per_package(tmp_path: Path) -> None:
    meta = tmp_path / "metaobjects"
    meta.mkdir()
    for pkg, name in (("shop", "Order"), ("crm", "Customer")):
        (meta / f"meta.{pkg}.json").write_text(json.dumps({"metadata.root": {
            "package": f"acme::{pkg}",
            "children": [{"object.entity": {"name": name, "children": [
                {"field.long": {"name": "id"}}, {"field.string": {"name": "title"}}]}}],
        }}))
    out = tmp_path / "gen"
    assert main(as_config(["gen", "--generators", GEN_SUITE, str(meta), "--out", str(out)])) == 0
    state = tmp_path / ".metaobjects" / ".gen-state"
    files = manifest_files(state)
    assert "acme.shop.json" in files and "acme.crm.json" in files
    assert all(k.endswith(("Order.py", "Order.json")) or "Order" in os.path.basename(k)
               for k in files["acme.shop.json"])
    assert all("Customer" in os.path.basename(k) for k in files["acme.crm.json"])
    assert not (state / ".hashes.json").exists()
    # Each key is recorded exactly once across the files.
    keys = [k for entries in files.values() for k in entries]
    assert len(keys) == len(set(keys))


def _seed_files(state: Path, files: dict[str, dict[str, object]]) -> Path:
    directory = state / ".hashes"
    directory.mkdir(parents=True, exist_ok=True)
    for name, entries in files.items():
        (directory / name).write_text(json.dumps(entries, indent=2) + "\n")
    return directory


def _snapshot(directory: Path) -> dict[str, tuple[bytes, int]]:
    return {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in sorted(directory.glob("*.json"))}


def _provenance_records() -> dict[str, tuple[str, str | None]]:
    return {r["path"]: (r["generatedBy"], r.get("sourceNode")) for r in VECTORS["provenance"]["records"]}


def _assert_provenance_after(directory: Path) -> None:
    vector = VECTORS["provenance"]
    assert manifest_files(directory.parent) == vector["afterFiles"]
    assert (directory / vector["goldenFile"]).read_text() == vector["goldenText"]


def test_provenance_vectors_through_a_run_session(tmp_path: Path) -> None:
    # The write loop records through the session, whose one save carries the provenance.
    state = _state(tmp_path)
    directory = _seed_files(state, VECTORS["provenance"]["beforeFiles"])
    set_placement_objects(str(state), OBJECTS)
    session = HashManifest(str(state))
    for path, (by, node) in _provenance_records().items():
        session.note_provenance(path, by, node)
    assert session.save()
    _assert_provenance_after(directory)

    before = _snapshot(directory)
    again = HashManifest(str(state))
    for path, (by, node) in _provenance_records().items():
        again.note_provenance(path, by, node)
    assert not again.save(), "nothing changed, so nothing is written"
    assert _snapshot(directory) == before


def test_gen_records_the_generator_and_node_of_each_per_entity_file(tmp_path: Path) -> None:
    meta = tmp_path / "metaobjects"
    meta.mkdir()
    (meta / "meta.shop.json").write_text(json.dumps({"metadata.root": {
        "package": "acme::shop",
        "children": [{"object.entity": {"name": "Order", "children": [
            {"field.long": {"name": "id"}}, {"field.string": {"name": "title"}}]}}],
    }}))
    out = tmp_path / "gen"
    argv = as_config(["gen", "--generators", GEN_SUITE, str(meta), "--out", str(out)])
    assert main(argv) == 0
    state = tmp_path / ".metaobjects" / ".gen-state"
    entries = read_manifest(state)
    model = entries["gen/Order.py"]
    assert isinstance(model, dict)
    assert list(model) == ["hash", "generatedBy", "sourceNode"]
    assert (model["generatedBy"], model["sourceNode"]) == ("entity", "acme::shop::Order")
    # A file of no one node (a package __init__) stays a plain hash.
    inits = [v for k, v in entries.items() if k.endswith("__init__.py")]
    assert inits and all(isinstance(v, str) for v in inits)

    before = _snapshot(state / ".hashes")
    assert main(argv) == 0
    assert _snapshot(state / ".hashes") == before, "a regeneration that changes nothing writes nothing"


@pytest.mark.parametrize(
    ("before", "after"),
    [
        (".gen-state/*\n!.gen-state/.hashes.json\n", ".gen-state/*\n!.gen-state/.hashes/\n"),
        (".gen-state/*\n", ".gen-state/*\n!.gen-state/.hashes/\n"),
        (
            ".gen-state/*\n!.gen-state/.hashes.json\n!.gen-state/.hashes/\n",
            ".gen-state/*\n!.gen-state/.hashes/\n",
        ),
        ("other\n", "other\n"),
    ],
)
def test_gitignore_migration(tmp_path: Path, before: str, after: str) -> None:
    state = _state(tmp_path)
    (state.parent / ".gitignore").write_text(before)
    (state / ".hashes.json").write_text(json.dumps({"gen/Order.ts": "h"}))
    HashManifest(str(state)).save()
    assert (state.parent / ".gitignore").read_text() == after
