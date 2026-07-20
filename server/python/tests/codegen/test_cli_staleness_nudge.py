"""``gen``/``verify`` print the agent-context staleness nudge to stderr.

Advisory only: a stale ``.metaobjects/.agent-context.json`` in the cwd causes ONE
stderr line but never changes the exit code, never writes, and a missing/corrupt
manifest is silently ignored.
"""

from __future__ import annotations

import json
from pathlib import Path

from metaobjects.cli import main

FIXTURE = (
    Path(__file__).parents[4]
    / "fixtures"
    / "persistence-conformance"
    / "canonical"
    / "meta.fitness.json"
)


def _meta_dir(tmp_path: Path) -> str:
    d = tmp_path / "meta"
    d.mkdir()
    (d / "meta.fitness.json").write_text(FIXTURE.read_text())
    return str(d)


def _write_manifest(cwd: Path, generated_by: str | None) -> None:
    m: dict[str, object] = {"version": 1, "servers": ["python"], "clients": [], "files": {}}
    if generated_by is not None:
        m["generatedBy"] = generated_by
    p = cwd / ".metaobjects" / ".agent-context.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(m, indent=2) + "\n")


def test_gen_nudges_on_stale_manifest(tmp_path, capsys, monkeypatch) -> None:
    meta_dir = _meta_dir(tmp_path)
    out = tmp_path / "out"
    monkeypatch.chdir(tmp_path)
    _write_manifest(tmp_path, "0.0.1-old")

    rc = main(["gen", meta_dir, "--out", str(out)])
    assert rc == 0  # advisory: never changes the exit code
    err = capsys.readouterr().err
    assert "0.0.1-old" in err
    assert "npx meta agent-docs" in err


def test_verify_nudges_on_stale_manifest(tmp_path, capsys, monkeypatch) -> None:
    meta_dir = _meta_dir(tmp_path)
    out = tmp_path / "out"
    monkeypatch.chdir(tmp_path)
    # Generate AND verify under the same cwd so verify --codegen is in-sync (no
    # DRIFT) — isolating the nudge from the codegen exit code.
    main(["gen", meta_dir, "--out", str(out)])
    capsys.readouterr()  # drain

    _write_manifest(tmp_path, "0.0.1-old")

    rc = main(["verify", meta_dir, "--codegen", "--out", str(out)])
    assert rc == 0
    err = capsys.readouterr().err
    assert "0.0.1-old" in err
    assert "npx meta agent-docs" in err


def test_gen_silent_when_no_manifest(tmp_path, capsys, monkeypatch) -> None:
    meta_dir = _meta_dir(tmp_path)
    out = tmp_path / "out"
    monkeypatch.chdir(tmp_path)  # no manifest in cwd

    rc = main(["gen", meta_dir, "--out", str(out)])
    assert rc == 0
    err = capsys.readouterr().err
    assert "npx meta agent-docs" not in err


def test_gen_silent_on_corrupt_manifest(tmp_path, capsys, monkeypatch) -> None:
    meta_dir = _meta_dir(tmp_path)
    out = tmp_path / "out"
    monkeypatch.chdir(tmp_path)
    p = tmp_path / ".metaobjects" / ".agent-context.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("{ this is not valid json ")  # corrupt → silently ignored

    rc = main(["gen", meta_dir, "--out", str(out)])
    assert rc == 0
    err = capsys.readouterr().err
    assert "npx meta agent-docs" not in err
