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

from metaobjects.cli import DOCS_COMMAND_REMOVED, main
from tests.codegen.config_helpers import as_config


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


def test_the_removed_docs_command_answers_any_flag_with_its_removal_line(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """``docs`` was removed in 1.1.0: whatever flags follow it, the answer is the one line
    that names the gen command and the migration section, never an unknown-flag refusal."""
    assert main(["docs", "--out", "o", "--bogus"]) == 2
    assert capsys.readouterr().err.strip() == DOCS_COMMAND_REMOVED


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
    argv = [args[0], str(meta), *args[1:]]
    assert main(argv if args[0] == "fmt" else as_config(argv)) == 1


def test_agent_docs_redirects_to_the_node_cli_and_exits_non_zero(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert main(["agent-docs"]) != 0
    assert "npx meta agent-docs" in capsys.readouterr().err


def test_agent_docs_old_invocation_with_ignored_flags_still_reaches_the_redirect(
    capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    out_dir = str(tmp_path / "ctx")
    assert main(["agent-docs", "--server", "python", "--client", "react", "--out", out_dir]) == 1
    assert "npx meta agent-docs --server python" in capsys.readouterr().err
    assert not (tmp_path / "ctx").exists()


def test_agent_docs_help_says_it_moved_and_does_not_claim_to_scaffold(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(["--help"])
    assert exit_info.value.code == 0
    top_level = capsys.readouterr().out
    assert "npx meta agent-docs" in top_level
    assert "scaffold the slim" not in top_level
    with pytest.raises(SystemExit):
        main(["agent-docs", "--help"])
    sub_help = capsys.readouterr().out
    for ignored_flag in ("--server", "--client", "--out"):
        assert ignored_flag not in sub_help
