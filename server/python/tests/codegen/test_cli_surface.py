"""The command-line surface the `metaobjects` console-script shares with every port's CLI.

- `--version`, `-v` and `-V` print the bare version and exit 0. None of the three was
  accepted: each died as "the following arguments are required: command" (exit 2).
- an unknown flag is refused by name, for the subcommand it was given to, with that
  subcommand's valid flags listed (exit 2). argparse attributed it to the TOP-LEVEL
  parser — "usage: metaobjects [-h] {gen,docs,...}" / "unrecognized arguments: --x" —
  naming neither the command nor a flag that would have worked.
- metadata that does not load exits 1 in gen, verify and fmt, as it does in the Node
  `meta` and `dotnet meta`.
"""
from __future__ import annotations

import importlib.metadata
import re
from pathlib import Path

import pytest

from metaobjects.cli import main


@pytest.mark.parametrize("flag", ["--version", "-v", "-V"])
def test_a_version_flag_prints_the_bare_version(flag: str, capsys: pytest.CaptureFixture[str]) -> None:
    assert main([flag]) == 0
    out = capsys.readouterr().out.strip()
    assert out == importlib.metadata.version("metaobjects")
    assert re.fullmatch(r"\d+\.\d+\.\d+([.\-+][0-9A-Za-z.]+)?", out)


@pytest.mark.parametrize(
    ("argv", "command", "a_valid_flag"),
    [
        (["gen"], "gen", "--out"),
        (["verify"], "verify", "--codegen"),
        (["fmt"], "fmt", "--check"),
        (["docs", "--out", "o"], "docs", "--api-subdir"),
        (["eject", "entity"], "eject", "--force"),
    ],
)
def test_an_unknown_flag_names_the_subcommand_and_its_valid_flags(
    argv: list[str], command: str, a_valid_flag: str, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main([*argv, "--bogus"]) == 2
    err = capsys.readouterr().err
    assert f"unknown flag --bogus for `metaobjects {command}`. Valid flags: " in err
    assert a_valid_flag in err
    assert "unrecognized arguments" not in err


@pytest.mark.parametrize(
    "argv",
    [
        ["gen", "--generators", "entity", "--out", "OUT"],
        ["verify", "--codegen", "--generators", "entity", "--out", "OUT"],
        ["fmt"],
    ],
)
def test_metadata_that_does_not_load_exits_1(argv: list[str], tmp_path: Path) -> None:
    meta = tmp_path / "meta"
    meta.mkdir()
    (meta / "meta.bad.json").write_text('{ "metadata.root": { "children": [ ')
    out = tmp_path / "out"
    out.mkdir()
    args = [a.replace("OUT", str(out)) for a in argv]
    assert main([args[0], str(meta), *args[1:]]) == 1
