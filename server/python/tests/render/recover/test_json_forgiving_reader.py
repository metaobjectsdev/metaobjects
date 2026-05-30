"""Unit tests for ``JsonForgivingReader`` (FR-010 stage 4).

Ported from JsonForgivingReader(Test|Tests) — all cases preserved including the
TRUNCATED sentinel and no-hang assertions.
"""
from __future__ import annotations

from metaobjects.render.recover.json_forgiving_reader import (
    TRUNCATED,
    JsonForgivingReader,
)


def _read(s: str | None) -> dict[str, object]:
    return JsonForgivingReader().read(s)


def test_clean_object() -> None:
    m = _read('{"a":"1","b":"two"}')
    assert m["a"] == "1"
    assert m["b"] == "two"


def test_trailing_comma() -> None:
    m = _read('{"a":"1",}')
    assert m["a"] == "1"
    assert len(m) == 1


def test_single_quotes() -> None:
    assert _read("{'a':'1'}")["a"] == "1"


def test_unquoted_keys() -> None:
    m = _read('{a:"1",b:"2"}')
    assert m["a"] == "1"
    assert m["b"] == "2"


def test_nested_object() -> None:
    m = _read('{"a":{"b":"1"}}')
    inner = m["a"]
    assert isinstance(inner, dict)
    assert inner["b"] == "1"


def test_array_values() -> None:
    m = _read('{"xs":["a","b"]}')
    assert m["xs"] == ["a", "b"]


def test_truncated_recovers_complete_prefix_keys() -> None:
    m = _read('{"a":"1","b":"2","c":')
    assert m["a"] == "1"
    assert m["b"] == "2"
    assert m["c"] is TRUNCATED


def test_unrecoverable_returns_empty() -> None:
    assert _read("@@@@") == {}


def test_malformed_array_brace_close_does_not_hang() -> None:
    m = _read('{"xs":[}')
    assert "xs" in m  # empty/partial list, no hang


def test_malformed_array_brace_close_after_comma_does_not_hang() -> None:
    m = _read('{"xs":[1,')
    assert isinstance(m["xs"], list)


def test_pathologically_deep_nesting_does_not_raise() -> None:
    # Python's recursion limit is far below the JVM/.NET stack; the depth guard must
    # keep recover never-throwing on adversarial deeply-nested input (no RecursionError).
    deep = '{"a":' + "[" * 5000 + "]" * 5000 + "}"
    m = _read(deep)  # must return, not raise
    assert isinstance(m, dict)


def test_empty_value_marks_truncated() -> None:
    m = _read('{"a":"1","c":}')
    assert m["a"] == "1"
    assert m["c"] is TRUNCATED


def test_empty_value_whitespace_marks_truncated() -> None:
    m = _read('{"a": }')
    assert m["a"] is TRUNCATED


def test_empty_value_then_more_keys_continues() -> None:
    m = _read('{"a":,"b":"2"}')
    assert m["a"] is TRUNCATED
    assert m["b"] == "2"
