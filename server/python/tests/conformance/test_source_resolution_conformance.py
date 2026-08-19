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


def _materialize(case: dict, root: Path) -> Path:
    """Materialize ``tree`` under ``root`` and ``config`` (when present) under the
    directory named by ``resolveFrom`` (project root when absent). Returns the
    directory resolution must be invoked against.
    """
    for rel, content in case["tree"].items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)

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
        with pytest.raises(ParseError) as e:
            resolve_collection(resolve_from)
        # A string pins the exact code; `True` only pins that resolution
        # RAISES — the malformed-config error code is deliberately not
        # pinned cross-port (see the corpus README).
        if isinstance(case["expectError"], str):
            assert e.value.code.value == case["expectError"]
        return

    # `expectFiles` is project-root-relative even when `resolveFrom` points
    # elsewhere — resolve against `tmp_path`, not `resolve_from`.
    root = tmp_path.resolve()
    got = {p.relative_to(root).as_posix() for p in resolve_collection(resolve_from)}
    assert got == set(case["expectFiles"])


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
    got = resolve_metadata_location(explicit=None, config=None, root=tmp_path)
    assert {Path(p).relative_to(tmp_path.resolve()).as_posix() for p in got} == {
        "model/meta.a.json"
    }


def test_explicit_relative_metadata_dir_resolves_against_cwd(
    tmp_path: Path, monkeypatch
) -> None:
    """A RELATIVE explicit <metadata_dir> must not resolve one level too deep.

    Regression for the plan's original defect: `resolve_sources(Path(explicit)
    .resolve().parent, [{"path": explicit}])` joins an already-absolute base
    with a still-relative spec, walking one directory too far up.

    A SINGLE-segment argument (e.g. ``"model"``) cannot distinguish the buggy
    formulation from the fixed one: ``Path("model").resolve().parent`` happens
    to land back at the project root, so the extra join silently cancels out.
    The defect only shows up with a MULTI-segment relative path (``"sub/model"``)
    — the buggy form resolves the base to ``.../sub`` and then joins the still-
    relative ``"sub/model"`` onto it, landing on ``.../sub/sub/model`` (does not
    exist -> ERR_SOURCE_UNRESOLVED) instead of ``.../sub/model``.
    """
    (tmp_path / "sub" / "model").mkdir(parents=True)
    (tmp_path / "sub" / "model" / "meta.a.json").write_text(
        '{"metadata.root":{"children":[]}}'
    )

    from metaobjects.cli import resolve_metadata_location

    monkeypatch.chdir(tmp_path)
    got = resolve_metadata_location(explicit="sub/model", config=None, root=tmp_path)
    assert {Path(p).relative_to(tmp_path.resolve()).as_posix() for p in got} == {
        "sub/model/meta.a.json"
    }
