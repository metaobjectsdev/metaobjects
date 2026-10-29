"""`metaobjects eject --undo` and the `gen` notice for owned copies identical to the shipped ones."""
from __future__ import annotations

from pathlib import Path

from metaobjects.cli import main
from tests.codegen.test_eject import _project

GEN = Path("codegen") / "generators"
RT = Path("codegen") / "runtime"


def _gen_cfg(tmp_path: Path, generators: str) -> Path:
    return _project(tmp_path, generators)


def test_undo_with_no_names_removes_identical_copies_and_prints_the_config_edit(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "entity", "names"]) == 0
    capsys.readouterr()
    assert main(["eject", "--undo"]) == 0
    out = capsys.readouterr().out
    assert not (tmp_path / GEN / "entity.py").exists()
    assert not (tmp_path / GEN / "names.py").exists()
    assert 'replace codegen.generators.entity:entity_model with "entity"' in out
    assert "metaobjects.config.yaml is not edited" in out


def test_undo_keeps_a_copy_that_differs_and_says_so(tmp_path: Path, monkeypatch, capsys) -> None:
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "entity", "names"]) == 0
    (tmp_path / GEN / "names.py").write_text(
        (tmp_path / GEN / "names.py").read_text() + "\nMINE = 1\n"
    )
    capsys.readouterr()
    assert main(["eject", "--undo"]) == 0
    assert not (tmp_path / GEN / "entity.py").exists()
    assert (tmp_path / GEN / "names.py").exists()


def test_undo_with_nothing_identical_says_so(tmp_path: Path, monkeypatch, capsys) -> None:
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "--undo"]) == 0
    assert "nothing to undo" in capsys.readouterr().out


def test_undo_by_name_refuses_a_differing_copy_and_removes_nothing(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "entity", "names"]) == 0
    (tmp_path / GEN / "names.py").write_text(
        (tmp_path / GEN / "names.py").read_text() + "\nMINE = 1\n"
    )
    capsys.readouterr()
    assert main(["eject", "--undo", "entity", "names"]) == 2
    err = capsys.readouterr().err
    assert "names differs" in err and "diff -u" in err and "--force" in err
    assert (tmp_path / GEN / "entity.py").exists()
    assert (tmp_path / GEN / "names.py").exists()


def test_undo_force_removes_a_differing_copy(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "names"]) == 0
    path = tmp_path / GEN / "names.py"
    path.write_text(path.read_text() + "\nMINE = 1\n")
    assert main(["eject", "--undo", "names", "--force"]) == 0
    assert not path.exists()


def test_undo_validates_every_name_before_removing(tmp_path: Path, monkeypatch, capsys) -> None:
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "entity"]) == 0
    capsys.readouterr()
    assert main(["eject", "--undo", "entity", "nope"]) == 2
    assert "nope" in capsys.readouterr().err
    assert main(["eject", "--undo", "entity", "names"]) == 2  # names is not owned
    assert (tmp_path / GEN / "entity.py").exists()


def test_undo_removes_identical_runtime_only_when_no_remaining_owner_uses_it(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "routes"]) == 0
    runtime = sorted((tmp_path / RT).glob("*.py"))
    assert runtime
    # A differing runtime copy is kept, and the generator still goes only if identical too.
    runtime[0].write_text(runtime[0].read_text() + "\nMINE = 1\n")
    capsys.readouterr()
    assert main(["eject", "--undo", "routes"]) == 2  # companion differs => not identical
    assert (tmp_path / GEN / "routes.py").exists()
    assert main(["eject", "--undo", "routes", "--force"]) == 0
    out = capsys.readouterr().out
    assert not (tmp_path / GEN / "routes.py").exists()
    assert runtime[0].exists() and f"kept {RT.as_posix()}/{runtime[0].name}" in out
    for other in runtime[1:]:
        assert not other.exists()


def test_eject_without_names_or_undo_is_an_error(capsys) -> None:
    assert main(["eject"]) == 2
    assert "--undo" in capsys.readouterr().err


def test_gen_names_identical_owned_copies_once_and_exits_zero(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "entity"]) == 0
    cfg = _gen_cfg(tmp_path, "codegen.generators.entity:entity_model")
    capsys.readouterr()
    assert main(["gen", "--config", str(cfg)]) == 0
    err = capsys.readouterr().err
    notes = [ln for ln in err.splitlines() if "identical to the shipped" in ln]
    assert len(notes) == 1
    assert "entity" in notes[0] and "metaobjects eject --undo" in notes[0]


def test_gen_is_silent_when_the_owned_copy_was_edited(tmp_path: Path, monkeypatch, capsys) -> None:
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "entity"]) == 0
    path = tmp_path / GEN / "entity.py"
    path.write_text(path.read_text() + "\nMINE = 1\n")
    cfg = _gen_cfg(tmp_path, "codegen.generators.entity:entity_model")
    capsys.readouterr()
    assert main(["gen", "--config", str(cfg)]) == 0
    assert "identical to the shipped" not in capsys.readouterr().err


def test_gen_without_owned_copies_prints_no_notice(tmp_path: Path, capsys) -> None:
    cfg = _gen_cfg(tmp_path, "entity")
    assert main(["gen", "--config", str(cfg)]) == 0
    assert "identical to the shipped" not in capsys.readouterr().err


def test_undo_with_a_repeated_name_removes_it_once(tmp_path: Path, monkeypatch, capsys) -> None:
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "entity"]) == 0
    capsys.readouterr()
    assert main(["eject", "--undo", "entity", "entity"]) == 0
    assert not (tmp_path / GEN / "entity.py").exists()


def test_undo_keeps_a_copy_whose_only_edit_is_a_reordering(tmp_path: Path, monkeypatch, capsys) -> None:
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "entity", "names"]) == 0
    path = tmp_path / GEN / "names.py"
    lines = path.read_text().splitlines()
    # Swap two adjacent, different, non-blank lines: the same lines in another order.
    i = next(i for i in range(len(lines) - 1)
             if lines[i].strip() and lines[i + 1].strip() and lines[i].strip() != lines[i + 1].strip())
    lines[i], lines[i + 1] = lines[i + 1], lines[i]
    path.write_text("\n".join(lines) + "\n")
    capsys.readouterr()
    assert main(["eject", "--undo"]) == 0
    assert not (tmp_path / GEN / "entity.py").exists()
    assert path.exists()
    assert main(["eject", "--undo", "names"]) != 0
    assert path.exists()
    assert main(["eject", "--undo", "--force", "names"]) == 0
    assert not path.exists()
