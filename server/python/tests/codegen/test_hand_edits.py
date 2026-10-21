"""``handEdits`` on a generator entry: ``keep`` (the default) or ``overwrite``.

``keep`` refuses to replace a generated file edited by hand, and refuses to delete one no
generator emits any more. ``overwrite`` replaces the edit with fresh output and re-records the
file, and deletes the edited orphan, naming each file it discards. ``verify --codegen`` follows
the same setting, so its remedy matches what ``gen`` will do.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.cli import main
from metaobjects.codegen.project_config import load_project_config

MANIFEST = Path(".metaobjects") / ".gen-state" / ".hashes.json"
KEEP = "targets:\n  app:\n    outDir: gen\n    generators: [entity]\n"
OVERWRITE = (
    "targets:\n  app:\n    outDir: gen\n    generators:\n"
    "      - name: entity\n        handEdits: overwrite\n"
)


def _value(name: str) -> dict:
    return {"object.value": {"name": name, "children": [{"field.string": {"name": "reading"}}]}}


def _write_model(root: Path, values: list[str]) -> None:
    meta = root / "metaobjects"
    meta.mkdir(parents=True, exist_ok=True)
    (meta / "meta.acme.json").write_text(
        json.dumps({"metadata.root": {"package": "acme", "children": [_value(v) for v in values]}}),
        encoding="utf-8",
    )


def _project(root: Path, config: str, values: list[str]) -> Path:
    _write_model(root, values)
    (root / "metaobjects.config.yaml").write_text(config, encoding="utf-8")
    return root / "gen"


def _file(out: Path, stem: str) -> Path:
    [found] = [p for p in out.rglob("*.py") if p.stem.lower() == stem.lower()]
    return found


def _manifest(root: Path) -> dict[str, str]:
    return json.loads((root / MANIFEST).read_text(encoding="utf-8"))


@pytest.mark.parametrize("config", [KEEP, OVERWRITE], ids=["keep", "overwrite"])
def test_an_edited_generated_file(
    config: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    out = _project(tmp_path, config, ["Telemetry"])
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    target = _file(out, "telemetry")
    fresh = target.read_text(encoding="utf-8")
    target.write_text(fresh + "# mine\n", encoding="utf-8")
    capsys.readouterr()

    verify = main(["verify", "--codegen"])
    err = capsys.readouterr().err
    assert verify == 1

    code = main(["gen"])
    captured = capsys.readouterr()
    if config is KEEP:
        assert "handEdits: overwrite" not in err
        assert code == 1
        assert target.read_text(encoding="utf-8").endswith("# mine\n")
        assert "refused" in captured.err
    else:
        assert "edited by hand; its generator sets handEdits: overwrite" in err
        assert "regenerate (metaobjects gen)" in err
        assert code == 0
        assert target.read_text(encoding="utf-8") == fresh
        assert "overwrote hand-edited" in captured.out
        # Re-baselined: the next run is quiet and verify is green.
        assert main(["gen"]) == 0
        assert "overwrote" not in capsys.readouterr().out
        assert main(["verify", "--codegen"]) == 0


@pytest.mark.parametrize("config", [KEEP, OVERWRITE], ids=["keep", "overwrite"])
def test_an_edited_orphan(
    config: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    out = _project(tmp_path, config, ["Telemetry"])
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    old = _file(out, "telemetry")
    old.write_text(old.read_text(encoding="utf-8") + "# mine\n", encoding="utf-8")
    _write_model(tmp_path, ["TelemetryReading"])
    capsys.readouterr()

    assert main(["verify", "--codegen"]) == 1
    err = capsys.readouterr().err

    assert main(["gen"]) == 0
    captured = capsys.readouterr()
    if config is KEEP:
        assert "will NOT delete them" in err
        assert old.exists()
        assert "NOT deleted" in captured.out
        assert [k for k in _manifest(tmp_path) if k.endswith(old.name)]
    else:
        assert "handEdits is overwrite, so gen deletes it" in err
        assert "will NOT delete them" not in err
        assert not old.exists()
        assert "deleted hand-edited" in captured.out
        assert not [k for k in _manifest(tmp_path) if k.endswith(old.name)]
        assert main(["verify", "--codegen"]) == 0


def test_a_file_nobody_generated_is_never_overwritten(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    out = _project(tmp_path, OVERWRITE, ["Telemetry"])
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    target = _file(out, "telemetry")
    # Forget the record: the file is now someone else's as far as gen can prove.
    (tmp_path / MANIFEST).write_text("{}", encoding="utf-8")
    target.write_text("# not generated\n", encoding="utf-8")
    assert main(["gen"]) == 1
    assert target.read_text(encoding="utf-8") == "# not generated\n"


def test_one_keep_target_in_a_shared_directory_protects_its_edited_orphans(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = OVERWRITE + "  other:\n    outDir: gen\n    generators: [names]\n"
    out = _project(tmp_path, config, ["Telemetry"])
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    old = _file(out, "telemetry")
    old.write_text(old.read_text(encoding="utf-8") + "# mine\n", encoding="utf-8")
    _write_model(tmp_path, ["TelemetryReading"])
    assert main(["gen"]) == 0
    assert old.exists()


def test_the_config_reads_both_entry_forms_and_rejects_a_bad_value(tmp_path: Path) -> None:
    cfg = tmp_path / "metaobjects.config.yaml"
    cfg.write_text(
        "targets:\n  app:\n    outDir: gen\n    generators:\n      - entity\n"
        "      - name: names\n        handEdits: overwrite\n      - name: dto\n        handEdits: keep\n",
        encoding="utf-8",
    )
    [target] = load_project_config(cfg).targets
    assert target.generators == ["entity", "names", "dto"]
    assert target.overwrite_hand_edits == frozenset({"names"})

    cfg.write_text(
        "targets:\n  app:\n    outDir: gen\n    generators:\n"
        "      - name: names\n        handEdits: always\n",
        encoding="utf-8",
    )
    with pytest.raises(Exception, match="handEdits"):
        load_project_config(cfg)
