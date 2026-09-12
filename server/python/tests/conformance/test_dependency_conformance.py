"""Runs the shared dependency corpus (FR-023) against the Python reference
implementation. Every port ships an equivalent runner reading this same file
(`fixtures/dependency-conformance/`, see its README for the case schema).

The predicates under test are the COMPOSED ones (DESIGN §11.1 item 2):
`collection.imported` keys on the lock's `packages`, and `in_scope` /
`in_migrate_scope` exclude what a dependency owns unless the project's own
scope NAMES that package. Mirrors
`server/typescript/packages/sdk/test/dependency-conformance.test.ts`.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from metaobjects.cli import _load_collection_result
from metaobjects.config.dependencies import LOCK_FILE
from metaobjects.config.source_resolver import resolve_collection_full
from metaobjects.errors import ParseError
from metaobjects.shared.base_types import TYPE_OBJECT

_CORPUS_DIR = (
    Path(__file__).resolve().parents[4] / "fixtures" / "dependency-conformance"
)
_CORPUS = _CORPUS_DIR / "cases.json"
_CASES = json.loads(_CORPUS.read_text())["cases"]

def test_corpus_is_non_empty() -> None:
    """A silent zero-case run is a failed gate, not a pass.

    `@pytest.mark.parametrize` over an empty list simply collects zero tests —
    pytest reports that as a SKIP, not a failure, so a corpus that quietly lost
    its cases would report green here with nothing actually checked. Mirrors
    the TS runner's identically-named guard.
    """
    assert len(_CASES) > 0


def _materialize(case: dict, root: Path) -> Path:
    """Materializes `case["tree"]` (and `case["treeFiles"]`, copied byte-for-byte
    from the corpus dir) under `root`, then writes `config` / `lock` (each when
    present) under `<resolveFrom>/.metaobjects/`. Returns the directory
    resolution must be invoked against. Mirrors the TS runner's `materialize`.
    """
    for rel, content in case["tree"].items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)

    for rel, corpus_rel in case.get("treeFiles", {}).items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(_CORPUS_DIR / corpus_rel, p)

    resolve_dir = root / case.get("resolveFrom", ".")
    metaobjects_dir = resolve_dir / ".metaobjects"

    if case["config"] is not None:
        metaobjects_dir.mkdir(parents=True, exist_ok=True)
        (metaobjects_dir / "config.json").write_text(json.dumps(case["config"], indent=2))
    if "lock" in case:
        metaobjects_dir.mkdir(parents=True, exist_ok=True)
        (metaobjects_dir / LOCK_FILE).write_text(json.dumps(case["lock"], indent=2))

    return resolve_dir


def _top_level_fqns(root) -> list[str]:
    """Every loaded top-level object's resolution key.

    ADR-0039 sanctioned own: `root.own_children()` is a ROOT-LEVEL scan
    (`metadata.root` is never extended, so own and effective children are the
    same set here) — exactly the "every loaded top-level object" the corpus's
    `expectImported`/`expectSelected`/`expectMigrateGoverned` arms are defined
    over (README: "EXHAUSTIVE set... over every loaded top-level object").
    """
    return [c.resolution_key() for c in root.own_children() if c.type == TYPE_OBJECT]


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_dependency_conformance_case(case: dict, tmp_path: Path) -> None:
    resolve_dir = _materialize(case, tmp_path)

    if "expectError" in case:
        with pytest.raises(ParseError) as e:
            resolve_collection_full(resolve_dir)
        assert e.value.code == case["expectError"]
        return

    # A case with neither expectFiles nor expectError is a malformed corpus
    # entry, not "expect zero files" — fail loudly rather than silently
    # passing it (same discipline as source-resolution-conformance).
    assert "expectFiles" in case, (
        f'corpus case "{case["name"]}" has neither expectFiles nor expectError'
    )

    collection = resolve_collection_full(resolve_dir)
    root = tmp_path.resolve()
    got = {p.relative_to(root).as_posix() for p in collection.files}
    assert got == set(case["expectFiles"])
    # A set comparison alone cannot see a duplicate emission — assert the RAW
    # list length too, before it is thrown away by the set conversion.
    assert len(collection.files) == len(case["expectFiles"])

    needs_load = (
        "expectImported" in case or "expectSelected" in case or "expectMigrateGoverned" in case
    )
    if needs_load:
        result = _load_collection_result(collection)
        assert not result.errors, [f"{e.code}: {e.message}" for e in result.errors]
        top_level = _top_level_fqns(result.root)

        if "expectImported" in case:
            imported = sorted(fqn for fqn in top_level if collection.imported(fqn))
            assert imported == sorted(case["expectImported"])
        if "expectSelected" in case:
            selected = sorted(fqn for fqn in top_level if collection.in_scope(fqn))
            assert selected == sorted(case["expectSelected"])
        if "expectMigrateGoverned" in case:
            governed = sorted(
                fqn
                for fqn in top_level
                if (collection.in_migrate_scope(fqn) if collection.in_migrate_scope else True)
            )
            assert governed == sorted(case["expectMigrateGoverned"])

    if "expectLoadError" in case:
        # Two arms produce a load-time failure: a loader-native `MetaError` in
        # `result.errors` (parse/merge/validation), or the post-load ownership
        # refusal (`ERR_DEPENDENCY_PACKAGE_NOT_OWNED`), which — mirroring the TS
        # `refuseUnownedPackages` — RAISES rather than populating `result.errors`.
        try:
            result = _load_collection_result(collection)
        except ParseError as exc:
            assert exc.code == case["expectLoadError"]
            assert "expectErrorFiles" not in case, (
                "the ownership-refusal ParseError carries no file provenance to assert"
            )
        else:
            assert result.errors, "expected a load error but the collection loaded cleanly"
            first = result.errors[0]
            assert first.code == case["expectLoadError"]
            if "expectErrorFiles" in case:
                files = getattr(getattr(first, "envelope", None), "files", None) or (
                    (first.source,) if first.source else ()
                )
                assert list(files) == case["expectErrorFiles"]
