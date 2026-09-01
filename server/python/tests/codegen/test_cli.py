"""Unit tests for the `metaobjects` console-script (SP-E Unit 2).

The CLI ships `gen` (run codegen to an out dir) and `verify` (regenerate to a
temp dir + diff against the committed out dir → fail on codegen drift). It is
named `metaobjects`, not `meta` (the Node schema CLI), and has NO `migrate`
subcommand — schema is owned by the Node `meta` per ADR-0015.
"""
from __future__ import annotations

import shutil
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


# ── auto-discovered template-spec (SP-1 §4) ──────────────────────────────────
#
# SP-1 §4 specified "--template-spec <path>, with a conventional default the port
# auto-discovers and the flag overriding", and that BOTH gen and verify read it.
# Only the flag on `gen` was ever built, so `verify --codegen` regenerated without
# the adopter's template generators and reported their committed output as stale —
# with a remedy that loops. The conventional path is <projectRoot>/template-spec.json,
# where projectRoot is the metadata dir's PARENT (the same anchor gen_state_dir_for
# already uses for .metaobjects/).


def _spec_project(tmp_path: Path, *, spec_name: str | None = "template-spec.json") -> Path:
    """A project laid out the way discovery expects.

        <root>/meta/              metadata dir   (so <root> is the project root)
        <root>/templates/         template refs resolve here
        <root>/template-spec.json the discovered spec

    Returns the project root. Pass spec_name=None to omit the spec file.
    """
    root = tmp_path / "proj"
    (root / "meta").mkdir(parents=True)
    (root / "meta" / "meta.shop.json").write_text(
        (_TEMPLATE_CORPUS / "metadata" / "meta.shop.json").read_text()
    )
    shutil.copytree(_TEMPLATE_CORPUS / "templates", root / "templates")
    if spec_name is not None:
        (root / spec_name).write_text((_TEMPLATE_CORPUS / "spec.json").read_text())
    return root


def test_gen_auto_discovers_template_spec(tmp_path: Path) -> None:
    """`gen` with NO --template-spec picks up <projectRoot>/template-spec.json."""
    root = _spec_project(tmp_path)
    out = root / "out"
    rc = main(["gen", str(root / "meta"), "--out", str(out), "--templates", str(root / "templates")])
    assert rc == 0
    assert (out / "Product.txt").exists(), "discovered spec's perEntity output missing"
    assert (out / "shop" / "_package.txt").exists()
    assert (out / "_model.txt").exists()


def test_gen_without_spec_file_emits_no_template_output(tmp_path: Path) -> None:
    """No spec file ⇒ today's behaviour exactly: the default suite only."""
    root = _spec_project(tmp_path, spec_name=None)
    out = root / "out"
    rc = main(["gen", str(root / "meta"), "--out", str(out), "--templates", str(root / "templates")])
    assert rc == 0
    assert not (out / "Product.txt").exists()
    assert not (out / "_model.txt").exists()


def test_verify_codegen_sees_the_discovered_template_spec(tmp_path: Path) -> None:
    """THE BUG. gen writes the spec's output; verify --codegen must regenerate WITH
    the same spec and report clean. Before the fix verify built its own generator
    list, never saw the spec, and convicted every spec-emitted file as `extra:`."""
    root = _spec_project(tmp_path)
    out = root / "out"
    assert main(["gen", str(root / "meta"), "--out", str(out),
                 "--templates", str(root / "templates")]) == 0
    # Non-vacuous: without discovery `gen` emits none of these, so a verify that
    # "passes" would only be agreeing that nothing exists.
    assert (out / "Product.txt").exists()
    assert (out / "_model.txt").exists()
    rc = main(["verify", "--codegen", str(root / "meta"), "--out", str(out),
               "--templates-root", str(root / "templates")])
    assert rc == 0, "verify --codegen convicted output that `gen` had just written"


def test_verify_codegen_still_catches_a_missing_template_file(tmp_path: Path) -> None:
    """The DISCRIMINATING test. The lazy fix is to make verify ignore files it does
    not recognise, which fixes the symptom by blinding the gate. Deleting one
    spec-generated file must still be reported as drift."""
    root = _spec_project(tmp_path)
    out = root / "out"
    assert main(["gen", str(root / "meta"), "--out", str(out),
                 "--templates", str(root / "templates")]) == 0
    (out / "Product.txt").unlink()
    rc = main(["verify", "--codegen", str(root / "meta"), "--out", str(out),
               "--templates-root", str(root / "templates")])
    assert rc == 1, "verify went blind — a deleted template-spec file is still drift"


def test_verify_codegen_catches_a_stale_template_file(tmp_path: Path) -> None:
    """Same guard, the other direction: edited content is drift, not just absence."""
    root = _spec_project(tmp_path)
    out = root / "out"
    assert main(["gen", str(root / "meta"), "--out", str(out),
                 "--templates", str(root / "templates")]) == 0
    (out / "Product.txt").write_text("stale\n")
    rc = main(["verify", "--codegen", str(root / "meta"), "--out", str(out),
               "--templates-root", str(root / "templates")])
    assert rc == 1


def test_verify_codegen_clean_for_a_py_emitting_spec(tmp_path: Path) -> None:
    """The reported symptom, reproduced exactly. A spec whose outputPattern ends in
    .py was visible to the old *.py-scoped comparison, so `gen` wrote it and the very
    next `verify --codegen` reported:

        error: generated code is out of sync with metadata.
          extra:   OrderService.py
          extra:   ProductService.py
        regenerate (metaobjects gen) and commit the result.

    — a remedy that loops, since regenerating cannot produce files the regen does not
    know about. (A spec emitting any OTHER extension hit the opposite failure: it was
    not compared at all. Both are covered here.)"""
    root = _spec_project(tmp_path, spec_name=None)
    (root / "template-spec.json").write_text(
        '{"generators": [{"name": "svc", "template": "entity", '
        '"scope": "perEntity", "outputPattern": "{name}Service.py"}]}'
    )
    out = root / "out"
    assert main(["gen", str(root / "meta"), "--out", str(out),
                 "--templates", str(root / "templates")]) == 0
    assert (out / "ProductService.py").exists()
    rc = main(["verify", "--codegen", str(root / "meta"), "--out", str(out),
               "--templates-root", str(root / "templates")])
    assert rc == 0, "the reported `extra:` false-conviction is back"


def test_verify_codegen_ignores_a_file_it_never_wrote(tmp_path: Path) -> None:
    """JURISDICTION. Broadening the comparison past *.py means the gate now sees every
    stranger's file in outDir. `out_dir` is a directory, not a namespace this tool owns
    (the TS gate's 0.24.3 ruling), so a file with no write record must NOT be convicted
    — otherwise the broadened glob turns a clean project red."""
    root = _spec_project(tmp_path)
    out = root / "out"
    assert main(["gen", str(root / "meta"), "--out", str(out),
                 "--templates", str(root / "templates")]) == 0
    (out / "NOTES.md").write_text("hand-written, not ours\n")
    (out / "sub").mkdir()
    (out / "sub" / "stray.txt").write_text("also not ours\n")
    rc = main(["verify", "--codegen", str(root / "meta"), "--out", str(out),
               "--templates-root", str(root / "templates")])
    assert rc == 0, "the gate convicted a file it never wrote"


def test_verify_codegen_ignores_pycache(tmp_path: Path) -> None:
    """Interpreter droppings are never artifacts, manifest or not."""
    root = _spec_project(tmp_path)
    out = root / "out"
    assert main(["gen", str(root / "meta"), "--out", str(out),
                 "--templates", str(root / "templates")]) == 0
    (out / "__pycache__").mkdir()
    (out / "__pycache__" / "Product.cpython-312.pyc").write_bytes(b"\x00\x01binary")
    rc = main(["verify", "--codegen", str(root / "meta"), "--out", str(out),
               "--templates-root", str(root / "templates")])
    assert rc == 0


def test_explicit_template_spec_flag_overrides_discovery(tmp_path: Path) -> None:
    """The flag wins over the discovered file (SP-1 §4: 'the flag overriding')."""
    root = _spec_project(tmp_path)
    other = root / "other-spec.json"
    other.write_text(
        '{"generators": [{"name": "only-ent", "template": "entity", '
        '"scope": "perEntity", "outputPattern": "{name}.flagged.txt"}]}'
    )
    out = root / "out"
    rc = main(["gen", str(root / "meta"), "--out", str(out),
               "--templates", str(root / "templates"), "--template-spec", str(other)])
    assert rc == 0
    assert (out / "Product.flagged.txt").exists(), "the flag's spec did not run"
    # The discovered spec must NOT also have run — the flag replaces it.
    assert not (out / "_model.txt").exists()


def test_malformed_discovered_spec_is_a_clean_error(tmp_path: Path, capsys) -> None:
    """A broken discovered file must fail loudly, not traceback and not be skipped
    silently — silently skipping would put gen and verify back out of agreement."""
    root = _spec_project(tmp_path)
    (root / "template-spec.json").write_text("{ not json")
    out = root / "out"
    rc = main(["gen", str(root / "meta"), "--out", str(out), "--templates", str(root / "templates")])
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
