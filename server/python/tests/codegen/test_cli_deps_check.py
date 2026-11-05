"""FR-023 Phase 2 (S2) — the Python CLI's `deps check` and `verify --deps`.

The three states themselves are the shared corpus's `expectCheck` arm
(`tests/conformance/test_dependency_conformance.py`); these tests pin the CLI around it: exit
codes, the named error code, that `--deps` is opt-in, and that a check never writes.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from metaobjects.cli import main

_CORPUS = Path(__file__).resolve().parents[4] / "fixtures" / "dependency-conformance"
_CASES = {c["name"]: c for c in json.loads((_CORPUS / "cases.json").read_text())["cases"]}


def _materialize(name: str, root: Path) -> Path:
    """Write one corpus case's tree under *root*; returns the project directory."""
    case = _CASES[name]
    for rel, content in case["tree"].items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    for rel, corpus_rel in case.get("treeFiles", {}).items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(_CORPUS / corpus_rel, p)
    project = root / case.get("resolveFrom", ".")
    meta = project / ".metaobjects"
    meta.mkdir(parents=True, exist_ok=True)
    (meta / "config.json").write_text(json.dumps(case["config"], indent=2))
    if "lock" in case:
        (meta / "deps.lock.json").write_text(json.dumps(case["lock"], indent=2))
    return project


def _sync_snapshot(project: Path) -> None:
    """Place the committed snapshot `meta deps sync` would have written for the v1 artifact."""
    dest = project / ".metaobjects" / "deps" / "acme-common"
    dest.mkdir(parents=True)
    shutil.copyfile(_CORPUS / "artifacts" / "acme-common-v1.json", dest / "acme-common.metaobjects.json")


def _run(project: Path, argv: list[str], monkeypatch: pytest.MonkeyPatch) -> int:
    monkeypatch.chdir(project)
    return main(argv)


def test_deps_check_current_exits_zero(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    project = _materialize("check-a-matching-artifact-is-current", tmp_path)
    _sync_snapshot(project)
    assert _run(project, ["deps", "check"], monkeypatch) == 0
    out = capsys.readouterr().out
    assert "acme-common: current — 1.0.0 (10fbf886)" in out


def test_deps_check_drifted_exits_one_and_names_the_code(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    project = _materialize("check-a-newer-artifact-than-the-lock-has-drifted", tmp_path)
    assert _run(project, ["deps", "check"], monkeypatch) == 1
    err = capsys.readouterr().err
    assert "acme-common: drifted — lock 1.0.0 (10fbf886), installed 1.1.0 (fa00b9f3)" in err
    assert "run meta deps sync" in err
    assert "ERR_DEPENDENCY_UPSTREAM_DRIFT" in err


def test_deps_check_unresolved_exits_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    project = _materialize("check-a-missing-path-is-unresolved", tmp_path)
    assert _run(project, ["deps", "check"], monkeypatch) == 1
    err = capsys.readouterr().err
    assert "acme-common: unresolved" in err
    assert "ERR_DEPENDENCY_UPSTREAM_DRIFT" in err


def test_deps_check_never_writes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    project = _materialize("check-a-newer-artifact-than-the-lock-has-drifted", tmp_path)
    before = sorted(p.relative_to(tmp_path).as_posix() for p in tmp_path.rglob("*") if p.is_file())
    lock_before = (project / ".metaobjects" / "deps.lock.json").read_bytes()
    _run(project, ["deps", "check"], monkeypatch)
    assert sorted(p.relative_to(tmp_path).as_posix() for p in tmp_path.rglob("*") if p.is_file()) == before
    assert (project / ".metaobjects" / "deps.lock.json").read_bytes() == lock_before


def test_deps_check_a_corrupt_lock_exits_two(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    project = _materialize("check-a-matching-artifact-is-current", tmp_path)
    _sync_snapshot(project)
    (project / ".metaobjects" / "deps.lock.json").write_text("not json")
    assert _run(project, ["deps", "check"], monkeypatch) == 2
    assert "ERR_DEPENDENCY_SNAPSHOT_STALE" in capsys.readouterr().err


def test_deps_check_with_nothing_declared_exits_zero(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    (tmp_path / ".metaobjects").mkdir()
    (tmp_path / ".metaobjects" / "config.json").write_text('{"schema_version": 1}')
    assert _run(tmp_path, ["deps", "check"], monkeypatch) == 0
    assert "no dependencies declared" in capsys.readouterr().out


def test_deps_check_reports_a_non_path_transport_as_unresolved(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The npm / python transports resolve through the installed packages, which only the Node
    toolchain reads: a check that cannot check must not pass."""
    (tmp_path / ".metaobjects").mkdir()
    (tmp_path / ".metaobjects" / "config.json").write_text(
        json.dumps({"schema_version": 1, "dependencies": [{"name": "acme-common", "npm": "@acme/common"}]})
    )
    assert _run(tmp_path, ["deps", "check"], monkeypatch) == 1
    err = capsys.readouterr().err
    assert "unresolved" in err and "meta deps check" in err


def test_deps_check_fails_when_the_locked_snapshot_is_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Hashes match the lock but no snapshot was ever synced: the set cannot load."""
    project = _materialize("check-a-matching-artifact-is-current", tmp_path)
    assert _run(project, ["deps", "check"], monkeypatch) == 1
    assert "does not load" in capsys.readouterr().err


def test_verify_deps_passes_when_current(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """`verify --deps` is the hash comparison (the same as TS's gate). Every `verify` also loads
    the model, which needs the synced snapshot."""
    project = _materialize("check-a-matching-artifact-is-current", tmp_path)
    _sync_snapshot(project)
    assert _run(project, ["verify", "--deps"], monkeypatch) == 0
    assert "every dependency's installed artifact matches the lock" in capsys.readouterr().out


def test_verify_deps_drift_exits_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    project = _materialize("check-a-newer-artifact-than-the-lock-has-drifted", tmp_path)
    assert _run(project, ["verify", "--deps"], monkeypatch) == 1
    assert "ERR_DEPENDENCY_UPSTREAM_DRIFT" in capsys.readouterr().err
