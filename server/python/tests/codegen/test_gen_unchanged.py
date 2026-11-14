"""ADR-0062 decisions 1 and 2: the manifest is written once per run and only when an entry
changed; a file whose bytes already match is never rewritten and reports as unchanged."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from metaobjects import codegen
from metaobjects.cli import main
from metaobjects.codegen import overwrite_policy

_DOC = {
    "metadata.root": {
        "package": "app",
        "children": [
            {"object.entity": {"name": "Order", "children": [
                {"field.long": {"name": "id"}},
                {"identity.primary": {"name": "pk", "@fields": ["id"]}},
            ]}},
            {"object.entity": {"name": "Item", "children": [
                {"field.long": {"name": "id"}},
                {"identity.primary": {"name": "pk", "@fields": ["id"]}},
            ]}},
        ],
    }
}


def _project(tmp_path: Path) -> Path:
    (tmp_path / "metaobjects").mkdir()
    (tmp_path / "metaobjects" / "meta.app.json").write_text(json.dumps(_DOC))
    (tmp_path / "metaobjects.config.yaml").write_text(
        "metadata: metaobjects\ntargets:\n  app:\n    outDir: gen\n    generators: [entity]\n"
    )
    return tmp_path


def test_unchanged_files_keep_mtime_manifest_untouched_and_report_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    root = _project(tmp_path)
    monkeypatch.chdir(root)
    assert main(["gen"]) == 0
    files = [f for f in (root / "gen").rglob("*.py")]
    assert files
    manifest = root / ".metaobjects" / ".gen-state" / ".hashes.json"
    before = manifest.read_bytes()
    for f in [*files, manifest]:
        os.utime(f, (1, 1))
    capsys.readouterr()

    assert main(["gen", "--force"]) == 0
    out = capsys.readouterr().out

    assert all(f.stat().st_mtime == 1 for f in files), "an identical file was rewritten"
    assert manifest.stat().st_mtime == 1, "an unchanged manifest was rewritten"
    assert manifest.read_bytes() == before
    assert "wrote 0 file(s)" in out and f"{len(files)} unchanged" in out
    assert not [ln for ln in out.splitlines() if ln.startswith(str(root / "gen"))]


def test_manifest_is_saved_once_per_run_and_only_when_it_changed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _project(tmp_path)
    monkeypatch.chdir(root)
    saves: list[int] = []
    real = overwrite_policy._save_hashes

    def counting(gen_state_dir: str, hashes: dict[str, str]) -> None:
        saves.append(len(hashes))
        real(gen_state_dir, hashes)

    monkeypatch.setattr(overwrite_policy, "_save_hashes", counting)
    assert main(["gen"]) == 0
    assert len(saves) == 1, "first run: one save for every written file"
    saves.clear()
    assert main(["gen", "--force"]) == 0
    assert saves == [], "a run that changes nothing saves nothing"


def test_manifest_bytes_keep_sorted_keys_and_extra_fields(tmp_path: Path) -> None:
    state = tmp_path / "state"
    state.mkdir()
    (state / ".hashes.json").write_text(
        json.dumps({"b.py": {"hash": "old", "owner": "jvm"}}, indent=2) + "\n"
    )
    session = overwrite_policy.HashManifest(str(state))
    session.record("b.py", "new", None)
    session.record("a.py", "x", None)
    assert session.save() is True
    raw = json.loads((state / ".hashes.json").read_text())
    assert list(raw) == ["a.py", "b.py"]
    assert raw["b.py"]["owner"] == "jvm" and raw["b.py"]["hash"] == overwrite_policy.content_hash("new")
    assert (state / ".hashes.json").read_text().endswith("}\n")
    assert session.save() is False


def test_decide_and_write_without_a_state_dir_does_not_rewrite_identical_bytes(
    tmp_path: Path,
) -> None:
    f = tmp_path / "x.py"
    f.write_text(codegen.constants.GENERATED_MARKER + "\nbody\n")
    os.utime(f, (1, 1))
    status = overwrite_policy.decide_and_write(str(f), f.read_text())
    assert status == "unchanged" and f.stat().st_mtime == 1


# --- item 9: verify --codegen renders in memory and creates no temp tree ----------------------


def test_verify_codegen_creates_no_temp_files_or_directories(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import tempfile

    (tmp_path / "proj").mkdir()
    root = _project(tmp_path / "proj")
    monkeypatch.chdir(root)
    assert main(["gen"]) == 0

    scratch = tmp_path / "scratch-tmp"
    scratch.mkdir()
    monkeypatch.setenv("TMPDIR", str(scratch))
    monkeypatch.setattr(tempfile, "tempdir", None)

    def forbidden(*_a: object, **_k: object) -> None:
        raise AssertionError("verify --codegen created a temp file or directory")

    for name in ("TemporaryDirectory", "mkdtemp", "mkstemp", "NamedTemporaryFile",
                 "TemporaryFile", "SpooledTemporaryFile"):
        monkeypatch.setattr(tempfile, name, forbidden)

    assert main(["verify", "--codegen", "--full"]) == 0       # renders, finds no drift
    target = next((root / "gen").glob("Order*.py"))
    target.write_text(target.read_text() + "# edited\n")
    assert main(["verify", "--codegen", "--full"]) == 1       # renders, reports the drift
    assert "drifted" in capsys.readouterr().err
    assert list(scratch.iterdir()) == []
    # No rendered tree anywhere under the project either: only what gen itself wrote.
    assert not [p for p in root.rglob("*") if "verify" in p.name.lower()]


def test_a_refused_orphan_stores_no_skip_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    root = _project(tmp_path)
    monkeypatch.chdir(root)
    assert main(["gen"]) == 0
    key = root / ".metaobjects" / ".gen-state" / ".fingerprint-python.json"
    assert key.exists()
    # Hand-edit Item's output, then drop Item from the model: it is an orphan the sweep
    # must refuse to delete (ADR-0062 counts a refusal as a failed run).
    orphan = next((root / "gen").glob("Item*.py"))
    orphan.write_text(orphan.read_text() + "# mine\n")
    doc = json.loads(json.dumps(_DOC))
    doc["metadata.root"]["children"] = doc["metadata.root"]["children"][:1]
    (root / "metaobjects" / "meta.app.json").write_text(json.dumps(doc))
    capsys.readouterr()

    assert main(["gen"]) == 0
    assert "NOT deleted" in capsys.readouterr().out
    assert not key.exists(), "a run whose orphan sweep refused stored a skip key"
    assert main(["gen"]) == 0
    assert "nothing changed" not in capsys.readouterr().out
