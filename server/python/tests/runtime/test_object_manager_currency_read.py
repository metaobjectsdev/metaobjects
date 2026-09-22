"""field.currency read decoding — the Python ObjectManager.

Currency is integer minor units, natively and on the wire. A table column stores it as
BIGINT, which pg8000 already hands back as an ``int``. A VIEW column need not: ``SUM`` over
BIGINT is Postgres ``numeric``, which pg8000 hands back as a ``Decimal`` — and a ``Decimal``
leaves a FastAPI route as the JSON STRING ``"100000"`` (Pydantic v2 serializes it that way),
where the contract says the number ``100000``. So the value's wire form depended on the
physical column type rather than on the declared field. The read codec now decodes an
integral currency value to ``int`` whatever the column's type.
"""
from __future__ import annotations

from decimal import Decimal

from metaobjects.loader.meta_data_loader import MetaDataLoader
from metaobjects.loader.sources import InMemoryStringSource
from metaobjects.runtime.object_manager import _decode_read_value

MODEL = """{"metadata.root": {"package": "acme", "children": [
  {"object.entity": {"name": "Leg", "children": [
    {"source.rdb": {"@table": "legs"}},
    {"field.long": {"name": "id"}},
    {"field.currency": {"name": "rate", "@currency": "USD"}},
    {"field.decimal": {"name": "weight", "@precision": 10, "@scale": 2}},
    {"identity.primary": {"name": "pk", "@fields": "id", "@generation": "increment"}}
  ]}}
]}}"""


def _field(name: str):
    result = MetaDataLoader().load([InMemoryStringSource(MODEL, "test.json")])
    assert result.errors == []
    leg = next(c for c in result.root.children() if c.name == "Leg")
    return next(f for f in leg.fields() if f.name == name)


def test_integral_decimal_currency_decodes_to_int_minor_units() -> None:
    value = _decode_read_value(_field("rate"), Decimal("100000"))
    assert value == 100000
    assert type(value) is int


def test_int_currency_is_unchanged() -> None:
    value = _decode_read_value(_field("rate"), 1099)
    assert value == 1099
    assert type(value) is int


def test_null_currency_stays_null() -> None:
    assert _decode_read_value(_field("rate"), None) is None


def test_fractional_decimal_currency_is_left_alone() -> None:
    # An avg over minor units can be fractional; no int is honest, so the value is
    # returned as read rather than silently rounded.
    value = _decode_read_value(_field("rate"), Decimal("12.5"))
    assert value == Decimal("12.5")


def test_field_decimal_keeps_its_decimal() -> None:
    value = _decode_read_value(_field("weight"), Decimal("12.50"))
    assert value == Decimal("12.50")
    assert type(value) is Decimal
