"""#267 — `metaobjects verify --codegen` declarative-config mode (per-target diff)."""
from __future__ import annotations

import json
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


def _record_as_written(tmp_path: Path, rel: str) -> None:
    """Add a write record for ``rel`` to the project manifest — i.e. make the file
    look like something MetaObjects WROTE on an earlier run. That is what makes a
    committed file a STALE artifact rather than a stranger, and the two now have
    different verdicts (see the jurisdiction rule in ``cli._is_ours_for``)."""
    manifest = tmp_path / ".metaobjects" / ".gen-state" / ".hashes.json"
    hashes = json.loads(manifest.read_text()) if manifest.exists() else {}
    hashes[rel] = "0" * 64
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps(hashes, indent=2, sort_keys=True) + "\n")


def test_verify_codegen_shared_outdir_detects_stale_extra(tmp_path: Path, capsys) -> None:
    """A genuinely stale committed file — one WE wrote on an earlier run that a fresh
    regen no longer emits (an entity since deleted or renamed) — is still flagged
    `extra` under a shared outDir.

    The fixture records the write, which is what "stale" means. It used to just drop a
    hand-written file into the outDir and assert it was convicted; that file had never
    been generated at all, so the test was pinning the pre-jurisdiction behaviour where
    the gate convicted every stranger in the directory."""
    cfg = _project(tmp_path, SHARED_OUTDIR)
    assert main(["gen", "--config", str(cfg)]) == 0
    (tmp_path / "shared/Orphan.py").write_text("# we wrote this before; regen no longer emits it\n")
    _record_as_written(tmp_path, "Orphan.py")
    rc = main(["verify", "--codegen", "--config", str(cfg)])
    assert rc == 1
    err = capsys.readouterr().err
    assert "extra" in err and "Orphan.py" in err


def test_verify_codegen_shared_outdir_ignores_a_stranger(tmp_path: Path) -> None:
    """The other half of the same rule: a file we have NO write record for is not ours
    to convict. `outDir` is a directory, not a namespace this tool owns — convicting
    strangers is what failed projects with zero drift (the TS gate's 0.24.3 ruling)."""
    cfg = _project(tmp_path, SHARED_OUTDIR)
    assert main(["gen", "--config", str(cfg)]) == 0
    (tmp_path / "shared/HAND_WRITTEN.md").write_text("mine, not yours\n")
    assert main(["verify", "--codegen", "--config", str(cfg)]) == 0


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


def test_verify_codegen_no_args_no_yaml_falls_back_to_neutral_config(
    tmp_path: Path, monkeypatch
) -> None:
    """No positional <metadata_dir> AND no metaobjects.config.yaml anywhere:
    `verify --codegen` must descend to the `.metaobjects/config.json` `sources`
    rung rather than erroring, per fix round 1 — and must agree with `gen`
    taking the SAME rung (a fresh gen is in sync; drift is still caught).

    The metadata lives under `model/`, NOT the built-in default `metaobjects/`
    directory, so this only passes if the declared `sources` path is actually
    consulted by BOTH commands.
    """
    model = tmp_path / "model"
    model.mkdir()
    (model / "meta.fitness.json").write_text(FITNESS.read_text())
    d = tmp_path / ".metaobjects"
    d.mkdir()
    (d / "config.json").write_text(
        '{"schema_version": 1, "sources": [{"path": "model"}]}'
    )

    monkeypatch.chdir(tmp_path)
    # No --generators here: `verify --codegen` has no such flag (it always
    # regenerates the full default suite), so `gen` must run the full suite
    # too or the diff reports the un-emitted generators as spurious drift —
    # same constraint the flag-mode docstring notes for --entities.
    assert main(["gen", "--out", "gen/models"]) == 0
    # Fresh gen -> no drift, via the same fallback rung.
    assert main(["verify", "--codegen", "--out", "gen/models"]) == 0
    # Drift the committed output; the fallback rung must still catch it.
    program = tmp_path / "gen/models/Program.py"
    program.write_text(program.read_text() + "\n# drift\n")
    assert main(["verify", "--codegen", "--out", "gen/models"]) == 1


def test_verify_codegen_neutral_fallback_threads_column_naming(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    """R31, at the `.metaobjects/config.json` fallback rung (no positional
    <metadata_dir>, no metaobjects.config.yaml): `verify --codegen` must thread
    `--column-naming` into its OWN regen here too, not only in explicit flag mode.
    A `names_generator.py`-bearing `Program` gets its `PROGRAM_PRICE_CENTS_COLUMN`
    constant emitted under the strategy `gen` was run with; a verify blind to the
    flag at this rung would report every such constant as drift.
    """
    model = tmp_path / "model"
    model.mkdir()
    (model / "meta.fitness.json").write_text(FITNESS.read_text())
    d = tmp_path / ".metaobjects"
    d.mkdir()
    (d / "config.json").write_text(
        '{"schema_version": 1, "sources": [{"path": "model"}]}'
    )

    monkeypatch.chdir(tmp_path)
    assert main(["gen", "--out", "gen/models", "--column-naming", "snake_case"]) == 0

    capsys.readouterr()
    # Matching strategy -> clean.
    rc_clean = main(
        ["verify", "--codegen", "--out", "gen/models", "--column-naming", "snake_case"]
    )
    assert rc_clean == 0, capsys.readouterr().err

    # Mismatched strategy -> the discriminating half: proves the flag is actually
    # read at this rung, not merely accepted and dropped.
    rc_drift = main(
        ["verify", "--codegen", "--out", "gen/models", "--column-naming", "literal"]
    )
    err = capsys.readouterr().err
    assert rc_drift == 1
    assert "drifted:" in err
    assert "program_names.py" in err


def test_config_mode_refuses_template_spec_instead_of_ignoring_it(
    tmp_path: Path, capsys
) -> None:
    """Declarative-config mode used to ACCEPT --template-spec and silently do nothing:
    `_cmd_gen_config` goes straight to `_run_gen_targets`, which has no spec pass. A
    flag that is parsed, documented, and inert is worse than one that refuses — the
    author has no way to tell it did not run."""
    cfg = _project(tmp_path)
    spec = tmp_path / "spec.json"
    spec.write_text(
        '{"generators": [{"name": "s", "template": "entity", '
        '"scope": "perEntity", "outputPattern": "{name}.txt"}]}'
    )
    rc = main(["gen", "--config", str(cfg), "--template-spec", str(spec)])
    assert rc == 2
    err = capsys.readouterr().err
    assert "--template-spec is not supported in declarative-config mode" in err
    # and it names the working alternative rather than just refusing
    assert "--out" in err


def test_config_mode_ignores_a_discovered_spec(tmp_path: Path) -> None:
    """A DISCOVERED spec must not hard-fail config mode — discovery is a convention,
    not a request. gen and verify both ignore it here, so they still agree."""
    cfg = _project(tmp_path)
    (tmp_path / "template-spec.json").write_text(
        '{"generators": [{"name": "s", "template": "entity", '
        '"scope": "perEntity", "outputPattern": "{name}.txt"}]}'
    )
    assert main(["gen", "--config", str(cfg)]) == 0
    assert main(["verify", "--codegen", "--config", str(cfg)]) == 0
