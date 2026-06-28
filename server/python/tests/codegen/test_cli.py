"""Unit tests for the `metaobjects` console-script (SP-E Unit 2).

The CLI ships `gen` (run codegen to an out dir) and `verify` (regenerate to a
temp dir + diff against the committed out dir → fail on codegen drift). It is
named `metaobjects`, not `meta` (the Node schema CLI), and has NO `migrate`
subcommand — schema is owned by the Node `meta` per ADR-0015.
"""
from __future__ import annotations

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
    """Copy the fitness fixture into a clean metadata directory for the loader."""
    d = tmp_path / "meta"
    d.mkdir()
    (d / "meta.fitness.json").write_text(FIXTURE.read_text())
    return str(d)


def test_gen_writes_files(tmp_path: Path) -> None:
    meta_dir = _meta_dir(tmp_path)
    out = tmp_path / "out"
    rc = main(["gen", meta_dir, "--out", str(out)])
    assert rc == 0
    written = list(out.rglob("*.py"))
    assert written, "gen wrote no files"
    # The fitness fixture has a Program entity → an entity model file.
    assert (out / "Program.py").exists()


def test_gen_entities_allowlist_emits_only_named(tmp_path: Path) -> None:
    """`gen --entities` emits only the named entities (the whole model is still
    loaded, so references resolve); the others are not written."""
    meta_dir = _meta_dir(tmp_path)
    out = tmp_path / "out"
    rc = main(["gen", meta_dir, "--out", str(out), "--entities", "Program,Week"])
    assert rc == 0
    assert (out / "Program.py").exists()
    assert (out / "Week.py").exists()
    # Other fixture entities are excluded by the allowlist.
    assert not (out / "Node.py").exists()
    assert not (out / "Measurement.py").exists()
    assert not (out / "Asset.py").exists()


def test_verify_entities_allowlist_in_sync(tmp_path: Path) -> None:
    """verify --codegen with the SAME --entities as the gen reports no drift
    (without the filter it would flag the un-emitted entities as missing)."""
    meta_dir = _meta_dir(tmp_path)
    out = tmp_path / "out"
    assert main(["gen", meta_dir, "--out", str(out), "--entities", "Program,Week"]) == 0
    assert main(["verify", meta_dir, "--out", str(out), "--entities", "Program,Week"]) == 0


def test_verify_in_sync_returns_zero(tmp_path: Path) -> None:
    meta_dir = _meta_dir(tmp_path)
    out = tmp_path / "out"
    assert main(["gen", meta_dir, "--out", str(out)]) == 0
    # Freshly generated → verify must report no drift.
    assert main(["verify", meta_dir, "--out", str(out)]) == 0


def test_verify_detects_drift(tmp_path: Path) -> None:
    meta_dir = _meta_dir(tmp_path)
    out = tmp_path / "out"
    assert main(["gen", meta_dir, "--out", str(out)]) == 0
    # Mutate a generated file → verify must detect codegen drift.
    target = out / "Program.py"
    target.write_text(target.read_text() + "\n# hand-edited drift\n")
    assert main(["verify", meta_dir, "--out", str(out)]) != 0


def test_verify_detects_missing_file(tmp_path: Path) -> None:
    meta_dir = _meta_dir(tmp_path)
    out = tmp_path / "out"
    assert main(["gen", meta_dir, "--out", str(out)]) == 0
    (out / "Program.py").unlink()
    assert main(["verify", meta_dir, "--out", str(out)]) != 0


def test_gen_load_error_returns_nonzero(tmp_path: Path) -> None:
    bad = tmp_path / "meta"
    bad.mkdir()
    (bad / "broken.json").write_text("{ not valid json")
    out = tmp_path / "out"
    assert main(["gen", str(bad), "--out", str(out)]) != 0


_TEMPLATE_CORPUS = Path(__file__).parents[4] / "fixtures" / "template-codegen-conformance"


def test_template_spec_output_gets_no_package_init(tmp_path: Path) -> None:
    # The format-agnostic --template-spec generators run as a separate pass with
    # emit_package_init=False: no Python __init__.py is injected next to their
    # (possibly non-Python) output, while the default Python suite still gets its
    # own __init__.py.
    out = tmp_path / "out"
    rc = main(
        [
            "gen",
            str(_TEMPLATE_CORPUS / "metadata"),
            "--out",
            str(out),
            "--template-spec",
            str(_TEMPLATE_CORPUS / "spec.json"),
            "--templates",
            str(_TEMPLATE_CORPUS / "templates"),
        ]
    )
    assert rc == 0
    # Template output landed (a .txt in a subdir of its own) ...
    assert (out / "shop" / "_package.txt").exists()
    # ... with NO spurious __init__.py scattered through the template subtree.
    assert not (out / "shop" / "__init__.py").exists()
    # The default Python suite still imports as a package.
    assert (out / "__init__.py").exists()


def test_template_spec_bad_ref_clean_error(tmp_path: Path, capsys) -> None:
    # An unresolvable template ref raises RenderError (not OSError/ValueError);
    # the CLI must surface it as a clean `error:` + nonzero exit, not a traceback.
    spec = tmp_path / "spec.json"
    spec.write_text(
        '{"generators": [{"name": "bad", "template": "does-not-exist", '
        '"scope": "perEntity", "outputPattern": "{name}.txt"}]}'
    )
    out = tmp_path / "out"
    rc = main(
        [
            "gen",
            str(_TEMPLATE_CORPUS / "metadata"),
            "--out",
            str(out),
            "--template-spec",
            str(spec),
            "--templates",
            str(_TEMPLATE_CORPUS / "templates"),
        ]
    )
    assert rc == 1
    err = capsys.readouterr().err
    assert "error:" in err
    assert "template-spec" in err


def test_no_migrate_subcommand(tmp_path: Path) -> None:
    # Schema is owned by the Node `meta` CLI (ADR-0015); Python must not ship it.
    import pytest

    with pytest.raises(SystemExit) as exc:
        main(["migrate", str(tmp_path), "--out", str(tmp_path / "out")])
    assert exc.value.code != 0
