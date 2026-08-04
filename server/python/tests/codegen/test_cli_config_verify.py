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

SHARED_OUTDIR = """
targets:
  a:
    outDir: shared
    generators: [entity]
    entities: [Program]
  b:
    outDir: shared
    generators: [entity]
    entities: [Week]
"""


def _project(tmp_path: Path, config_text: str = TWO_TARGETS) -> Path:
    meta = tmp_path / "metaobjects"
    meta.mkdir()
    (meta / "meta.fitness.json").write_text(FITNESS.read_text())
    cfg = tmp_path / "metaobjects.config.yaml"
    cfg.write_text(config_text)
    return cfg


def test_verify_codegen_no_args_in_sync(tmp_path: Path) -> None:
    cfg = _project(tmp_path)
    assert main(["gen", "--config", str(cfg)]) == 0
    # Fresh gen → no drift across every target.
    assert main(["verify", "--codegen", "--config", str(cfg)]) == 0


def test_verify_codegen_bare_defaults_to_codegen(tmp_path: Path, monkeypatch) -> None:
    _project(tmp_path)
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
    _project(tmp_path)
    meta = tmp_path / "metaobjects"
    out = tmp_path / "flagout"
    assert main(["gen", str(meta), "--out", str(out)]) == 0
    assert main(["verify", str(meta), "--out", str(out)]) == 0


def test_verify_templates_config_mode_requires_metadata_dir(tmp_path: Path) -> None:
    """`verify --templates` is not config-driven — the guard returns exit 2 when
    no positional metadata_dir is given (config mode / --templates only drives
    --codegen)."""
    assert main(["verify", "--templates"]) == 2


def test_verify_codegen_shared_outdir_disjoint_entities_in_sync(tmp_path: Path) -> None:
    """Two targets sharing an outDir with DISJOINT entities: gen succeeds, and
    verify --codegen must NOT report the co-resident target's files as false
    `extra` drift. The diff is union-of-co-resident-regen vs the shared dir."""
    cfg = _project(tmp_path, SHARED_OUTDIR)
    assert main(["gen", "--config", str(cfg)]) == 0
    assert (tmp_path / "shared/Program.py").exists()
    assert (tmp_path / "shared/Week.py").exists()
    # Bug repro: this exits 1 today with a false `extra` on both targets.
    assert main(["verify", "--codegen", "--config", str(cfg)]) == 0


def test_verify_codegen_shared_outdir_detects_real_drift(tmp_path: Path, capsys) -> None:
    """Real drift is still detected under a shared outDir: hand-editing one
    co-resident target's file flags it as `drifted` (labeled for the shared unit)."""
    cfg = _project(tmp_path, SHARED_OUTDIR)
    assert main(["gen", "--config", str(cfg)]) == 0
    target = tmp_path / "shared/Week.py"
    target.write_text(target.read_text() + "\n# hand-edited drift\n")
    rc = main(["verify", "--codegen", "--config", str(cfg)])
    assert rc == 1
    err = capsys.readouterr().err
    assert "drifted" in err and "Week.py" in err


def test_verify_codegen_shared_outdir_detects_stale_extra(tmp_path: Path, capsys) -> None:
    """A genuinely stale committed file (produced by no target) is still flagged
    `extra` under a shared outDir — stale detection is preserved under sharing."""
    cfg = _project(tmp_path, SHARED_OUTDIR)
    assert main(["gen", "--config", str(cfg)]) == 0
    (tmp_path / "shared/Orphan.py").write_text("# not produced by any target\n")
    rc = main(["verify", "--codegen", "--config", str(cfg)])
    assert rc == 1
    err = capsys.readouterr().err
    assert "extra" in err and "Orphan.py" in err


def test_verify_target_scoping_widens_to_shared_outdir(tmp_path: Path, capsys) -> None:
    """`verify --target a` on a shared-outDir config widens to the shared outDir
    as a unit: no false positive on a clean tree (with a widening note), and a
    drift in target b's file IS caught because the shared dir is verified together."""
    cfg = _project(tmp_path, SHARED_OUTDIR)
    assert main(["gen", "--config", str(cfg)]) == 0
    # Clean tree: --target a widens to cover the shared dir (b co-resident) → no false positive.
    rc = main(["verify", "--codegen", "--config", str(cfg), "--target", "a"])
    assert rc == 0
    note = capsys.readouterr().err
    assert "note:" in note and "shares an outDir" in note and "b" in note
    # Drift target b's file; --target a still catches it (shared dir verified as a unit).
    week = tmp_path / "shared/Week.py"
    week.write_text(week.read_text() + "\n# drift\n")
    rc = main(["verify", "--codegen", "--config", str(cfg), "--target", "a"])
    assert rc == 1
    assert "Week.py" in capsys.readouterr().err
