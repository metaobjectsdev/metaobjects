"""``naming.collections`` names the pluralizer an object without ``@collectionName`` takes its
collection name from. Python generates nothing from it yet, but a project shared with a port that
does carries the key, so Python reads it, refuses an unknown name like ``columns`` and ``tables``,
and keeps the selected name on the loaded rules.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.config.neutral_config import read_neutral_config
from metaobjects.errors import ParseError
from metaobjects.naming import (
    BUILTIN_PLURALIZERS,
    DEFAULT_PLURALIZER,
    NamingRules,
    pluralizer,
    register_pluralizer,
    registered_pluralizers,
    reset_naming_strategies_for_testing,
)


def _config(tmp_path: Path, naming: dict) -> Path:
    cfg = tmp_path / ".metaobjects"
    cfg.mkdir()
    (cfg / "config.json").write_text(json.dumps({"schema_version": 1, "naming": naming}))
    return tmp_path


def test_the_built_ins_pluralize_or_keep_the_name() -> None:
    assert BUILTIN_PLURALIZERS == ("standard", "none")
    assert DEFAULT_PLURALIZER == "standard" and NamingRules().collections is None
    assert pluralizer("standard")("Category") == "Categories"
    assert pluralizer("standard")("CaseHistory") == "CaseHistories"
    assert pluralizer("standard")("Address") == "Addresses"
    assert pluralizer("none")("CaseHistory") == "CaseHistory"


def test_the_config_reads_a_built_in(tmp_path: Path) -> None:
    config = read_neutral_config(_config(tmp_path, {"collections": "none"}))
    assert config is not None and config.naming.collections == "none"


def test_absent_stays_absent(tmp_path: Path) -> None:
    config = read_neutral_config(_config(tmp_path, {"columns": "snake_case"}))
    assert config is not None and config.naming.collections is None


def test_an_unknown_pluralizer_is_refused_naming_the_kind(tmp_path: Path) -> None:
    with pytest.raises(ParseError, match=r'"naming.collections" names "latin".*collection-naming \(pluralizer\)'):
        read_neutral_config(_config(tmp_path, {"collections": "latin"}))


def test_an_application_pluralizer_is_selectable(tmp_path: Path) -> None:
    register_pluralizer("py-test-shout", lambda n: n.upper() + "S")
    try:
        assert "py-test-shout" in registered_pluralizers()
        config = read_neutral_config(_config(tmp_path, {"collections": "py-test-shout"}))
        assert config is not None and config.naming.collections == "py-test-shout"
    finally:
        reset_naming_strategies_for_testing()
    assert "py-test-shout" not in registered_pluralizers()


def test_a_built_in_pluralizer_cannot_be_replaced() -> None:
    with pytest.raises(ValueError, match="built in"):
        register_pluralizer("none", lambda n: n)
