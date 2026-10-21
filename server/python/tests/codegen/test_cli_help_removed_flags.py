"""MINOR 6: a flag that is refused is not advertised in --help."""
from __future__ import annotations

import pytest

from metaobjects.cli import main


@pytest.mark.parametrize("command", ["gen", "verify"])
def test_help_does_not_list_the_removed_column_naming_flag(
    command: str, capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(SystemExit):
        main([command, "--help"])
    assert "--column-naming" not in capsys.readouterr().out
