"""A numeric primary key is read from text only when the text is canonical decimal.

``int()``, ``float()`` and ``Decimal()`` accept ``0x1``-free but still loose spellings
(``" 1 "``, ``+1``, ``1_0``, ``1e0``, Unicode digits, ``nan``), so text that names no key
used to name a row. The key codec refuses all of it with the OM's existing ``ValueError``.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest

from metaobjects.loader.meta_data_loader import MetaDataLoader
from metaobjects.loader.sources import InMemoryStringSource
from metaobjects.runtime.object_manager import _coerce_key_value

MODEL = """{"metadata.root": {"package": "acme", "children": [
  {"object.entity": {"name": "Thing", "children": [
    {"source.rdb": {"@table": "things"}},
    {"field.long": {"name": "id"}},
    {"field.decimal": {"name": "price", "@precision": 10, "@scale": 2}},
    {"field.double": {"name": "ratio"}},
    {"field.string": {"name": "code"}},
    {"field.uuid": {"name": "ref"}},
    {"identity.primary": {"name": "pk", "@fields": "id"}}
  ]}}
]}}"""


def _field(name: str) -> Any:
    result = MetaDataLoader().load([InMemoryStringSource(MODEL, "test.json")])
    assert result.errors == []
    thing = next(c for c in result.root.children() if c.name == "Thing")
    return next(f for f in thing.fields() if f.name == name)


@pytest.mark.parametrize("text,expected", [("1", 1), ("0", 0), ("-7", -7), ("123456789012", 123456789012)])
def test_canonical_integer_key_is_read(text: str, expected: int) -> None:
    value = _coerce_key_value(_field("id"), text)
    assert value == expected and type(value) is int


@pytest.mark.parametrize("text", [
    "0x1", "1e0", "+1", " 1", "1 ", "", "01", "-0", "1.", "1_0", "٣", "0b1", "0o1",
    "1.5", "-", "00", "\n1",
])
def test_non_canonical_integer_key_is_refused(text: str) -> None:
    with pytest.raises(ValueError, match="Thing.*id"):
        _coerce_key_value(_field("id"), text)


@pytest.mark.parametrize("text,expected", [("1.5", "1.5"), ("0", "0"), ("-7.25", "-7.25"), ("0.5", "0.5")])
def test_canonical_decimal_key_is_read(text: str, expected: str) -> None:
    assert _coerce_key_value(_field("price"), text) == Decimal(expected)


@pytest.mark.parametrize("text", [
    "0x1", "1e0", "1.", ".5", "+1.5", "nan", "inf", "-inf", "-0", "-0.0", "01.5", " 1.5", "1.5 ", "1_0.5", "1.5e1", "1.٣",
])
def test_non_canonical_decimal_key_is_refused(text: str) -> None:
    with pytest.raises(ValueError, match="Thing.*price"):
        _coerce_key_value(_field("price"), text)


def test_double_key_beyond_float_range_is_refused() -> None:
    assert _coerce_key_value(_field("ratio"), "1.5") == 1.5
    with pytest.raises(ValueError, match="Thing.*ratio"):
        _coerce_key_value(_field("ratio"), "9" * 400)


def test_string_key_is_untouched() -> None:
    assert _coerce_key_value(_field("code"), "0123") == "0123"
    assert _coerce_key_value(_field("code"), " 0x1 ") == " 0x1 "


def test_native_numbers_pass_through() -> None:
    assert _coerce_key_value(_field("id"), 7) == 7
