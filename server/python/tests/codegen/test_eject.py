"""`metaobjects eject` — own a reference generator (ADR-0034 Amendment 3).

An adopter copies a generator into `codegen/generators/`, wires it as `module:symbol`, and
`gen` / `verify --codegen` run the copy instead of the packaged one. The copy is verbatim;
eject never overwrites without --force and never edits the config.
"""
from __future__ import annotations

import importlib
from pathlib import Path

import pytest

from metaobjects.cli import main
from metaobjects.codegen.generator_registry import GENERATOR_REGISTRY

FITNESS = (
    Path(__file__).parents[4]
    / "fixtures"
    / "persistence-conformance"
    / "canonical"
    / "meta.fitness.json"
)


def _packaged_source(name: str) -> str:
    entry = GENERATOR_REGISTRY[name]
    assert entry.source_module is not None
    module = importlib.import_module(entry.source_module)
    return Path(module.__file__).read_text(encoding="utf-8")


def _project(tmp_path: Path, generators: str) -> Path:
    (tmp_path / "metaobjects").mkdir()
    (tmp_path / "metaobjects" / "meta.fitness.json").write_text(FITNESS.read_text())
    cfg = tmp_path / "metaobjects.config.yaml"
    cfg.write_text(f"targets:\n  models:\n    outDir: gen\n    generators: [{generators}]\n")
    return cfg


def test_every_ejectable_entry_names_its_source(tmp_path: Path) -> None:
    ejectable = [e for e in GENERATOR_REGISTRY.values() if e.source_module is not None]
    # `template` is a primitive with no emit logic of its own; everything else is ejectable.
    assert {e.name for e in ejectable} == set(GENERATOR_REGISTRY) - {"template"}
    for e in ejectable:
        module = importlib.import_module(e.source_module)
        assert callable(getattr(module, e.symbol)), e.name


def test_eject_copies_verbatim_and_refuses_to_overwrite(tmp_path: Path, monkeypatch, capsys) -> None:
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "entity"]) == 0
    copy = tmp_path / "codegen" / "generators" / "entity.py"
    assert copy.read_text(encoding="utf-8") == _packaged_source("entity")
    assert (tmp_path / "codegen" / "__init__.py").exists()
    assert (tmp_path / "codegen" / "generators" / "__init__.py").exists()
    out = capsys.readouterr().out
    assert "codegen.generators.entity:entity_model" in out

    copy.write_text("# mine\n", encoding="utf-8")
    assert main(["eject", "entity"]) == 1
    assert copy.read_text(encoding="utf-8") == "# mine\n"
    assert main(["eject", "entity", "--force"]) == 0
    assert copy.read_text(encoding="utf-8") == _packaged_source("entity")


def test_eject_unknown_name_writes_nothing(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "entity", "nope"]) == 2
    assert not (tmp_path / "codegen").exists()


def test_owned_copy_unchanged_generates_identical_output(tmp_path: Path, monkeypatch) -> None:
    packaged = tmp_path / "packaged"
    packaged.mkdir()
    _project(packaged, "entity")
    monkeypatch.chdir(packaged)
    assert main(["gen"]) == 0

    owned = tmp_path / "owned"
    owned.mkdir()
    _project(owned, "codegen.generators.entity:entity_model")
    monkeypatch.chdir(owned)
    assert main(["eject", "entity"]) == 0
    assert main(["gen"]) == 0

    a = {p.relative_to(packaged / "gen"): p.read_bytes() for p in (packaged / "gen").rglob("*.py")}
    b = {p.relative_to(owned / "gen"): p.read_bytes() for p in (owned / "gen").rglob("*.py")}
    assert a and a == b


def test_edited_owned_copy_drives_gen_and_verify(tmp_path: Path, monkeypatch) -> None:
    _project(tmp_path, "codegen.generators.entity:entity_model")
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "entity"]) == 0
    copy = tmp_path / "codegen" / "generators" / "entity.py"
    source = copy.read_text(encoding="utf-8")
    marker = "OWNED-BY-THE-ADOPTER"
    # Edit the emit logic: prefix every generated module with a marker line.
    edited = source.replace(
        "class EntityModelGenerator",
        f"_MARKER = '# {marker}\\n'\n\n\nclass EntityModelGenerator",
        1,
    )
    assert edited != source
    edited += (
        "\n\n_orig_generate = EntityModelGenerator.generate\n\n\n"
        "def _marked(self, ctx):\n"
        "    files = _orig_generate(self, ctx)\n"
        "    for f in files:\n"
        "        f.content = _MARKER + f.content\n"
        "    return files\n\n\n"
        "EntityModelGenerator.generate = _marked\n"
    )
    copy.write_text(edited, encoding="utf-8")

    assert main(["gen"]) == 0
    program = (tmp_path / "gen" / "Program.py").read_text(encoding="utf-8")
    assert marker in program
    assert main(["verify", "--codegen"]) == 0


def test_list_marks_owned_copies(tmp_path: Path, monkeypatch, capsys) -> None:
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "names"]) == 0
    capsys.readouterr()
    assert main(["gen", "--list"]) == 0
    out = capsys.readouterr().out
    line = next(ln for ln in out.splitlines() if ln.startswith("names — "))
    assert "[owned — identical]" in line

    copy = tmp_path / "codegen" / "generators" / "names.py"
    copy.write_text(copy.read_text(encoding="utf-8") + "\n# my change\n", encoding="utf-8")
    assert main(["gen", "--list"]) == 0
    out = capsys.readouterr().out
    line = next(ln for ln in out.splitlines() if ln.startswith("names — "))
    assert "[owned — DIFFERS: 0 behind, 1 of your own]" in line


@pytest.mark.parametrize("token", ["codegen.generators.missing:x", "nocolon.module"])
def test_bad_owned_token_is_a_clear_error(tmp_path: Path, monkeypatch, capsys, token: str) -> None:
    _project(tmp_path, token)
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) != 0
    assert token.split(":")[0] in capsys.readouterr().err
