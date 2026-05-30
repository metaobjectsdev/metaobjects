"""Unit tests for ``recover_map`` — FR-010 null-safe coercion helpers.

Mirrors RecoverMap(Test|Tests). Python has a single ``int`` type, so ``as_int`` and
``as_long`` are intentionally identical (both ``Optional[int]``).
"""
from __future__ import annotations

from metaobjects.render.recover import recover_map


def _data() -> dict[str, object]:
    return {"s": "hi", "n": 7, "d": 1.5, "b": True, "xs": ["a", "b"]}


def test_as_string_reads_and_defaults_none() -> None:
    assert recover_map.as_string(_data(), "s") == "hi"
    assert recover_map.as_string({}, "s") is None


def test_as_int_narrows_number() -> None:
    assert recover_map.as_int(_data(), "n") == 7
    assert recover_map.as_int({}, "n") is None


def test_as_long_reads() -> None:
    assert recover_map.as_long(_data(), "n") == 7


def test_as_double_reads() -> None:
    assert recover_map.as_double(_data(), "d") == 1.5


def test_as_bool_reads() -> None:
    assert recover_map.as_bool(_data(), "b") is True
    assert recover_map.as_bool({}, "b") is None


def test_as_string_list_reads_and_defaults_none() -> None:
    assert recover_map.as_string_list(_data(), "xs") == ["a", "b"]
    assert recover_map.as_string_list({}, "xs") is None


def test_as_string_list_coerces_elements_to_string() -> None:
    m: dict[str, object] = {"xs": [1, 2]}
    assert recover_map.as_string_list(m, "xs") == ["1", "2"]


def test_numeric_helpers_return_none_for_non_numbers_and_never_throw() -> None:
    # A non-numeric string yields None (not an exception); recover helpers never throw.
    m: dict[str, object] = {"s": "abc", "b": True}
    assert recover_map.as_int(m, "s") is None
    assert recover_map.as_long(m, "s") is None
    assert recover_map.as_double(m, "s") is None
    # A boolean is not treated as a number (Java `instanceof Number` parity).
    assert recover_map.as_int(m, "b") is None
    assert recover_map.as_long(m, "b") is None
    assert recover_map.as_double(m, "b") is None


def test_as_int_truncates_floating_toward_zero() -> None:
    m: dict[str, object] = {"d": 42.9}
    assert recover_map.as_int(m, "d") == 42  # truncate, not round
    assert recover_map.as_long(m, "d") == 42
    m2: dict[str, object] = {"d": -42.9}
    assert recover_map.as_int(m2, "d") == -42
