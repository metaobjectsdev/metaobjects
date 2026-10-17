"""``metaobjects gen`` deletes a file it wrote earlier and no longer generates.

The rc.5 re-check found the gap: renaming the value object ``Telemetry`` to
``TelemetryReading`` (or a release moving api-docs pages to another package) left the old
files on disk, ``verify --codegen`` reported them as ``extra:`` and said "regenerate", and
regenerating never removed anything, so an agent following the remedy looped. The rule is
the one every port shares (``codegen/orphan_sweep.py``): an untouched file the manifest
records and no generator emits is deleted and forgotten; an edited one is refused by name;
a file the manifest does not record is never touched; a narrowed run sweeps nothing.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.cli import main

MANIFEST = Path(".metaobjects") / ".gen-state" / ".hashes.json"


def _value(name: str) -> dict:
    return {"object.value": {"name": name, "children": [{"field.string": {"name": "reading"}}]}}


def _entity(name: str) -> dict:
    return {"object.entity": {"name": name, "children": [
        {"source.rdb": {"@table": name.lower()}},
        {"field.long": {"name": "id"}},
        {"identity.primary": {"@fields": "id"}},
    ]}}


def _write_model(root: Path, package: str, children: list[dict]) -> None:
    meta = root / "metaobjects"
    meta.mkdir(parents=True, exist_ok=True)
    (meta / "meta.acme.json").write_text(
        json.dumps({"metadata.root": {"package": package, "children": children}}),
        encoding="utf-8",
    )


def _project(root: Path, children: list[dict], *, package: str = "acme",
             config: str = "targets:\n  app:\n    outDir: gen\n    generators: [entity]\n") -> Path:
    _write_model(root, package, children)
    (root / "metaobjects.config.yaml").write_text(config, encoding="utf-8")
    return root / "gen"


def _manifest(root: Path) -> dict[str, str]:
    return json.loads((root / MANIFEST).read_text(encoding="utf-8"))


def _find(out: Path, name: str) -> list[Path]:
    return sorted(out.rglob(name))


def test_a_renamed_value_object_is_deleted_and_verify_goes_green(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    out = _project(tmp_path, [_value("Telemetry")])
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    [old] = _find(out, "telemetry.py") or _find(out, "Telemetry.py")

    _write_model(tmp_path, "acme", [_value("TelemetryReading")])
    capsys.readouterr()
    assert main(["verify", "--codegen"]) == 1
    err = capsys.readouterr().err
    assert "gen deletes it" in err
    assert "regenerate (metaobjects gen) and commit the result." in err

    assert main(["gen"]) == 0
    stdout = capsys.readouterr().out
    assert not old.exists()
    assert f"removed {old}" in stdout
    assert not [k for k in _manifest(tmp_path) if k.endswith(old.name)]

    assert main(["verify", "--codegen"]) == 0


def test_a_hand_edited_orphan_is_refused_and_verify_says_delete_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    out = _project(tmp_path, [_value("Telemetry")])
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    [old] = _find(out, "telemetry.py") or _find(out, "Telemetry.py")
    old.write_text(old.read_text(encoding="utf-8") + "# mine\n", encoding="utf-8")

    _write_model(tmp_path, "acme", [_value("TelemetryReading")])
    capsys.readouterr()
    assert main(["gen"]) == 0
    stdout = capsys.readouterr().out
    assert old.exists()
    assert "NOT deleted" in stdout
    assert str(old.relative_to(tmp_path)) in stdout
    # Still recorded, so the refusal repeats until someone resolves it.
    assert str(old.relative_to(tmp_path)) in _manifest(tmp_path)

    assert main(["verify", "--codegen"]) == 1
    err = capsys.readouterr().err
    assert "edited by hand" in err
    assert "delete each one, or move your edits" in err
    assert "regenerate (metaobjects gen)" not in err


def test_api_docs_pages_that_move_package_leave_no_stale_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    config = (
        "targets:\n"
        "  app:\n    outDir: gen\n    generators: [entity]\n"
        "  docs:\n    outDir: docs\n    generators: [api-docs]\n"
    )
    _project(tmp_path, [_entity("Leg")], package="acme::iam", config=config)
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    docs = tmp_path / "docs"
    before = [p for p in docs.rglob("Leg.md") if "iam" in p.parts]
    assert before, sorted(str(p) for p in docs.rglob("*"))

    _write_model(tmp_path, "acme::ops", [_entity("Leg")])
    capsys.readouterr()
    assert main(["gen"]) == 0
    assert [p for p in docs.rglob("Leg.md") if "ops" in p.parts]
    assert not [p for p in before if p.exists()]
    assert main(["verify", "--codegen"]) == 0


def test_a_file_nobody_generated_is_never_touched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    out = _project(tmp_path, [_value("Telemetry")])
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    mine = out / "helpers.py"
    mine.write_text("MINE = 1\n", encoding="utf-8")
    _write_model(tmp_path, "acme", [_value("TelemetryReading")])
    assert main(["gen"]) == 0
    assert mine.exists()


def test_an_entities_narrowed_run_deletes_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    out = _project(tmp_path, [_value("Telemetry"), _value("Other")])
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    [old] = _find(out, "telemetry.py") or _find(out, "Telemetry.py")
    _write_model(tmp_path, "acme", [_value("TelemetryReading"), _value("Other")])
    capsys.readouterr()
    assert main(["gen", "--entities", "Other"]) == 0
    assert old.exists()
    assert "Skipped orphan cleanup" in capsys.readouterr().out


def test_a_target_run_spares_a_shared_directory_another_target_writes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = (
        "targets:\n"
        "  app:\n    outDir: gen\n    generators: [entity]\n"
        "  docs:\n    outDir: gen\n    generators: [api-docs]\n"
    )
    _project(tmp_path, [_entity("Leg")], config=config)
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    pages = list((tmp_path / "gen").rglob("Leg.md"))
    assert pages
    assert main(["gen", "--target", "app"]) == 0
    assert all(p.exists() for p in pages)
