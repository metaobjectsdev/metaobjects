"""Unit tests for `metaobjects gen --list` and `--generators` (stable-name selection).

ADR-0021 D3. ``gen --list`` prints the registered generators (stable name +
description) and exits 0 without running codegen. ``--generators a,b`` selects a
subset by stable name via the registry; an unknown name is a clear error (exit
non-zero). Omitting ``--generators`` keeps the existing default suite behavior.
"""
from __future__ import annotations

from pathlib import Path

from metaobjects.cli import main
from metaobjects.codegen.generator_registry import GENERATOR_REGISTRY, list_generators

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


def test_gen_list_prints_all_and_exits_zero(capsys, tmp_path: Path) -> None:
    rc = main(["gen", "--list"])
    assert rc == 0
    out = capsys.readouterr().out
    # Every registered stable name appears in the listing.
    for name in GENERATOR_REGISTRY:
        assert name in out, f"--list omitted {name!r}"
    # Exactly the 10 python-slice names are registered.
    assert len(GENERATOR_REGISTRY) == 10
    # One line per generator, "<name> — <description>".
    listed = [e.name for e in list_generators()]
    assert sorted(listed) == sorted(GENERATOR_REGISTRY.keys())


def test_gen_list_does_not_run_codegen(capsys, tmp_path: Path) -> None:
    out = tmp_path / "out"
    rc = main(["gen", "--list", "--out", str(out)])
    assert rc == 0
    # --list must NOT write any generated files even when --out is given.
    assert not out.exists() or not list(out.rglob("*.py"))


def test_generators_selects_subset_by_stable_name(tmp_path: Path) -> None:
    meta_dir = _meta_dir(tmp_path)
    out = tmp_path / "out"
    rc = main(["gen", meta_dir, "--out", str(out), "--generators", "entity"])
    assert rc == 0
    files = {p.name for p in out.rglob("*.py")}
    # entity-only selection emits the Program entity model...
    assert "Program.py" in files


def test_template_generator_reachable_via_generators(tmp_path: Path) -> None:
    # `template` is NOT in the default suite, but the registry makes it reachable.
    assert "template" in GENERATOR_REGISTRY
    meta_dir = _meta_dir(tmp_path)
    out = tmp_path / "out"
    # The registry's `template` primitive walks to zero outputs (no-op default),
    # so selecting it alone is a valid, non-throwing run that writes nothing.
    rc = main(["gen", meta_dir, "--out", str(out), "--generators", "template"])
    assert rc == 0


def test_unknown_generator_name_is_clear_error(capsys, tmp_path: Path) -> None:
    meta_dir = _meta_dir(tmp_path)
    out = tmp_path / "out"
    rc = main(["gen", meta_dir, "--out", str(out), "--generators", "entity,bogus"])
    assert rc != 0
    err = capsys.readouterr().err
    assert "bogus" in err
