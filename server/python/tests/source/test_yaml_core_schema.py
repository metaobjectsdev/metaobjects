"""YAML 1.2 core-schema scalar resolution (regression for the YAML 1.1 coercion).

PyYAML's SafeLoader resolves scalars as YAML 1.1, so ``off``/``no``/``1:30``/
``0777``/``2024-01-02`` changed type silently while the TS loader (the ``yaml``
package, 1.2 core schema) kept them as the authored text. The Python loader
must agree with it, and a duplicate mapping key is a parse error, not last-wins.
"""
from __future__ import annotations

import pytest
import yaml  # type: ignore[import-untyped]

from metaobjects.source.yaml_positions import parse_yaml_with_positions


def _scalar(text: str):
    return parse_yaml_with_positions(f"k: {text}\n")["k"]


@pytest.mark.parametrize(
    "text",
    ["off", "on", "no", "yes", "y", "n", "Off", "NO", "1:30", "2024-01-02", "1_000", "0b11", "+.inf_"],
)
def test_yaml11_scalars_stay_strings(text: str) -> None:
    assert _scalar(text) == text


def test_core_schema_scalars() -> None:
    assert _scalar("true") is True
    assert _scalar("False") is False
    assert _scalar("TRUE") is True
    assert _scalar("null") is None
    assert _scalar("~") is None
    assert _scalar("") is None
    assert _scalar("42") == 42
    assert _scalar("0777") == 777  # 1.2 core: decimal, as the TS loader reads it
    assert _scalar("-7") == -7
    assert _scalar("0x1F") == 31
    assert _scalar("0o17") == 15
    assert _scalar("1.5") == 1.5
    assert _scalar("1e3") == 1000.0
    assert _scalar(".inf") == float("inf")
    assert _scalar('"off"') == "off"


def test_duplicate_mapping_key_is_an_error() -> None:
    with pytest.raises(yaml.YAMLError):
        parse_yaml_with_positions("a: 1\na: 2\n")


def test_positions_still_tracked() -> None:
    value = parse_yaml_with_positions("a: off\nb: no\n")
    assert value["a"] == "off"
    from metaobjects.source.yaml_positions import get_yaml_position

    assert get_yaml_position(value, "b").line == 2
