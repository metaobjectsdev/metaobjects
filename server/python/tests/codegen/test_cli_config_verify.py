"""#267 — `metaobjects verify --codegen` declarative-config mode (per-target diff)."""
from __future__ import annotations

from pathlib import Path

from metaobjects.cli import main

FITNESS = (
    Path(__file__).parents[4]
    / "fixtures"
    / "persistence-conformance"
    / "canonical"
    / "meta.fitness.json"
)

TWO_TARGETS = """
targets:
  models:
    outDir: gen/models
    generators: [entity]
    entities: [Program, Week]
  other:
    outDir: gen/other
    generators: [entity]
    entities: [Node, Measurement]
"""


def _project(tmp_path: Path) -> Path:
    meta = tmp_path / "metaobjects"
    meta.mkdir()
    (meta / "meta.fitness.json").write_text(FITNESS.read_text())
    cfg = tmp_path / "metaobjects.config.yaml"
    cfg.write_text(TWO_TARGETS)
    return cfg


def test_verify_codegen_no_args_in_sync(tmp_path: Path) -> None:
    cfg = _project(tmp_path)
    assert main(["gen", "--config", str(cfg)]) == 0
    # Fresh gen → no drift across every target.
    assert main(["verify", "--codegen", "--config", str(cfg)]) == 0


def test_verify_codegen_bare_defaults_to_codegen(tmp_path: Path, monkeypatch) -> None:
    cfg = _project(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    assert main(["verify"]) == 0  # bare verify → --codegen default, config-driven


def test_verify_codegen_detects_drift_in_one_target(tmp_path: Path, capsys) -> None:
    cfg = _project(tmp_path)
    assert main(["gen", "--config", str(cfg)]) == 0
    target = tmp_path / "gen/other/Node.py"
    target.write_text(target.read_text() + "\n# hand-edited drift\n")
    rc = main(["verify", "--codegen", "--config", str(cfg)])
    assert rc == 1
    err = capsys.readouterr().err
    assert "[other]" in err and "drifted" in err


def test_verify_codegen_target_scopes(tmp_path: Path) -> None:
    cfg = _project(tmp_path)
    assert main(["gen", "--config", str(cfg)]) == 0
    # Drift in `other`, but scope verify to `models` → clean.
    target = tmp_path / "gen/other/Node.py"
    target.write_text(target.read_text() + "\n# drift\n")
    assert main(["verify", "--codegen", "--config", str(cfg), "--target", "models"]) == 0
    assert main(["verify", "--codegen", "--config", str(cfg), "--target", "other"]) == 1


def test_verify_flag_path_still_works_with_config_present(tmp_path: Path) -> None:
    """Back-compat: legacy `verify <dir> --out` diff is unchanged when a config exists."""
    cfg = _project(tmp_path)
    meta = tmp_path / "metaobjects"
    out = tmp_path / "flagout"
    assert main(["gen", str(meta), "--out", str(out)]) == 0
    assert main(["verify", str(meta), "--out", str(out)]) == 0


def test_verify_templates_config_mode_requires_metadata_dir(tmp_path: Path) -> None:
    """`verify --templates` is not config-driven — the guard returns exit 2 when
    no positional metadata_dir is given (config mode / --templates only drives
    --codegen)."""
    assert main(["verify", "--templates"]) == 2
