"""Runs the shared source-resolution corpus against this port.

Reads `fixtures/source-resolution-conformance/cases.json` — the single
committed source of truth. There is no per-port fixture.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.config.source_resolver import resolve_collection
from metaobjects.errors import ParseError

_CORPUS = (
    Path(__file__).resolve().parents[4]
    / "fixtures"
    / "source-resolution-conformance"
    / "cases.json"
)

_CASES = json.loads(_CORPUS.read_text())["cases"]


def test_corpus_is_non_empty() -> None:
    """A silent zero-case run is a failed gate, not a pass.

    `@pytest.mark.parametrize` over an empty list simply collects zero tests —
    pytest reports that as a SKIP, not a failure, so a corpus that quietly lost
    its cases (e.g. a bad path, a JSON-parsing bug) would report green here
    with nothing actually checked. Mirrors the TS runner's identically-named
    guard (`source-resolution-conformance.test.ts`).
    """
    assert len(_CASES) > 0


def _materialize(case: dict, root: Path) -> Path:
    """Materialize ``tree`` under ``root``, then ``symlinks`` (I1 — a symlinked
    source root, or a symlinked subdirectory inside a walked tree), then
    ``config`` (when present) under the directory named by ``resolveFrom``
    (project root when absent). Returns the directory resolution must be
    invoked against.
    """
    for rel, content in case["tree"].items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)

    # Materialized AFTER tree — both link/target are project-root-relative.
    for link_rel, target_rel in case.get("symlinks", {}).items():
        link = root / link_rel
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(root / target_rel, target_is_directory=True)

    resolve_from = root / case.get("resolveFrom", ".")

    if case["config"] is not None:
        d = resolve_from / ".metaobjects"
        d.mkdir(parents=True, exist_ok=True)
        (d / "config.json").write_text(json.dumps(case["config"], indent=2))

    return resolve_from


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_source_resolution_conformance(case: dict, tmp_path: Path) -> None:
    resolve_from = _materialize(case, tmp_path)

    if "expectError" in case:
        # A string pins the exact code. `True` leaves the CODE unpinned but still
        # requires ParseError — a malformed config that crashes with a raw
        # TypeError must fail this case, not pass it. `errorIsNative` lifts only
        # the type requirement, for the one case whose raise comes from the
        # filesystem walk (SymlinkLoopError) and never reaches a coded-error
        # constructor; widening the whole arm instead would quietly relax the six
        # malformed-config cases from "a coded parse failure" to "anything".
        expected = case["expectError"]
        expected_type = Exception if case.get("errorIsNative") else ParseError
        with pytest.raises(expected_type) as e:
            resolve_collection(resolve_from)
        if isinstance(expected, str):
            assert e.value.code.value == expected
        return

    # `expectFiles` is project-root-relative even when `resolveFrom` points
    # elsewhere — resolve against `tmp_path`, not `resolve_from`.
    root = tmp_path.resolve()
    raw = resolve_collection(resolve_from)
    got = {p.relative_to(root).as_posix() for p in raw}
    assert got == set(case["expectFiles"])
    # A set comparison alone cannot see a duplicate emission (two entries for the
    # same file collapse invisibly into one set element) —
    # `overlapping-sources-yield-each-file-once` specifically exercises
    # resolve_collection's own de-duplication, so the RAW list length must be
    # asserted too, before it is thrown away by the set conversion.
    assert len(raw) == len(case["expectFiles"])


def test_cli_falls_back_to_neutral_config(tmp_path: Path, monkeypatch) -> None:
    """No positional metadata_dir and no YAML `metadata` key => neutral config wins."""
    (tmp_path / "model").mkdir()
    (tmp_path / "model" / "meta.a.json").write_text('{"metadata.root":{"children":[]}}')
    d = tmp_path / ".metaobjects"
    d.mkdir()
    (d / "config.json").write_text(
        json.dumps({"schema_version": 1, "sources": [{"path": "model"}]})
    )

    from metaobjects.cli import resolve_metadata_location

    monkeypatch.chdir(tmp_path)
    # FR-023: resolve_metadata_location now returns the full `Collection` at
    # every rung — `.files` is the resolved file list a no-dependencies project
    # still gets byte-identically (own files only, nothing led by an artifact).
    collection = resolve_metadata_location(config=None, root=tmp_path)
    assert {Path(p).relative_to(tmp_path.resolve()).as_posix() for p in collection.files} == {
        "model/meta.a.json"
    }


def test_api_docs_with_no_metadata_key_falls_back_to_neutral_config(
    tmp_path: Path, monkeypatch
) -> None:
    """The api reference is an entry in the config's generator list since 1.1.0 (ADR-0034
    Amendment 9; it was ``metaobjects docs``). A config that names no ``metadata`` leaves the
    location to the ladder's later rungs, so the neutral ``.metaobjects/config.json``
    ``sources`` rung is reachable from ``gen`` — as it was from ``docs`` and from a ``gen``
    with no config before 1.1.0 required one.
    """
    (tmp_path / "model").mkdir()
    # `gen` runs a generator over the model's objects, so the model declares one.
    (tmp_path / "model" / "meta.a.json").write_text(
        '{"metadata.root":{"package":"app","children":[{"object.value":{"name":"Point",'
        '"children":[{"field.int":{"name":"x"}}]}}]}}'
    )
    d = tmp_path / ".metaobjects"
    d.mkdir()
    (d / "config.json").write_text(
        json.dumps({"schema_version": 1, "sources": [{"path": "model"}]})
    )

    (tmp_path / "metaobjects.config.yaml").write_text(
        "targets:\n  docs:\n    outDir: out\n    generators: [api-docs]\n"
    )

    from metaobjects.cli import main

    monkeypatch.chdir(tmp_path)
    out = tmp_path / "out"
    rc = main(["gen"])
    assert rc == 0
    assert (out / "api" / "python" / "README.md").exists()


def test_api_docs_with_metaobjects_config_yaml_honors_declared_libraries(
    tmp_path: Path, monkeypatch
) -> None:
    """The api reference used to be written by `docs`, whose no-positional branch loaded
    `metaobjects.config.yaml` purely to read its `metadata` key and then dropped
    `config.providers` and `config.libraries`. Since 1.1.0 it is an `api-docs` entry `gen`
    runs, so a project declaring `libraries: ["ai"]` and `extends:
    metaobjects::ai::LlmCallBase` must resolve for it exactly as for every other entry (see
    `test_shipped_library_ai.py::TestTheCliCanLoadTheLibrary`).
    """
    (tmp_path / "metadata").mkdir()
    (tmp_path / "metadata" / "meta.app.yaml").write_text(
        "metadata:\n"
        "  package: app::trace\n"
        "  children:\n"
        "    - object.entity:\n"
        "        name: AdopterCall\n"
        "        extends: metaobjects::ai::LlmCallBase\n"
        "        children:\n"
        "          - source.rdb:       { table: adopter_call, role: primary }\n"
        "          - identity.primary: { name: id, fields: [\"spanId\"] }\n",
        encoding="utf-8",
    )
    (tmp_path / "metaobjects.config.yaml").write_text(
        "metadata: metadata\n"
        'libraries: ["ai"]\n'
        "targets:\n"
        "  main:\n"
        "    outDir: docs-out\n"
        "    generators: [api-docs]\n",
        encoding="utf-8",
    )

    from metaobjects.cli import main

    monkeypatch.chdir(tmp_path)
    out = tmp_path / "docs-out"
    rc = main(["gen"])
    assert rc == 0
    assert (out / "api" / "python" / "README.md").exists()
