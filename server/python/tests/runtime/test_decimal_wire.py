"""The Python half of the decimal wire rule against the shared vectors (ADR-0019 Amendment 1)."""
from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

import pytest

from metaobjects.codegen.runtime.decimal_wire import (
    coerce_decimal_fields,
    decimal_from_double15,
    format_decimal,
    parse_decimal,
    parse_decimal_operand,
    parse_json_object,
    to_wire,
)

_VECTORS = json.loads(
    (Path(__file__).resolve().parents[4] / "fixtures" / "decimal-wire" / "vectors.json").read_text()
)


@pytest.mark.parametrize("v", _VECTORS["format"], ids=lambda v: v["in"])
def test_format(v: dict[str, str]) -> None:
    assert format_decimal(Decimal(v["in"])) == v["out"]


def _body_value(text: str) -> object:
    return json.loads(text, parse_float=Decimal)


@pytest.mark.parametrize("v", _VECTORS["parse"], ids=lambda v: v["json"])
def test_parse_body(v: dict[str, object]) -> None:
    raw = _body_value(str(v["json"]))
    if v.get("error"):
        with pytest.raises(ValueError):
            parse_decimal(raw)
    elif v["value"] is None:
        assert raw is None
    else:
        assert parse_decimal(raw) == Decimal(str(v["value"]))


@pytest.mark.parametrize("v", _VECTORS["filterOperand"], ids=lambda v: repr(v["text"]))
def test_parse_filter_operand(v: dict[str, object]) -> None:
    if v.get("error"):
        with pytest.raises(ValueError):
            parse_decimal_operand(str(v["text"]))
    else:
        assert parse_decimal_operand(str(v["text"])) == Decimal(str(v["value"]))


@pytest.mark.parametrize("v", _VECTORS["double15"], ids=lambda v: v["double"])
def test_double15(v: dict[str, str]) -> None:
    assert format_decimal(decimal_from_double15(float(v["double"]))) == v["out"]


def test_a_body_number_is_never_a_float() -> None:
    body = parse_json_object('{"a": 12345678901234567.89, "b": 0.1}')
    assert body["a"] == Decimal("12345678901234567.89") and body["b"] == Decimal("0.1")


def test_the_sum_of_two_doubles_reads_as_the_decimal_they_were_written_as() -> None:
    assert decimal_from_double15(0.1 + 0.2) == Decimal("0.3")


def test_out_of_range_is_refused_not_rounded() -> None:
    with pytest.raises(ValueError):
        parse_decimal("1e999999999")
    with pytest.raises(ValueError):
        parse_decimal_operand("1e5000")
    with pytest.raises(ValueError):
        format_decimal(Decimal("1e5000"))


def test_non_finite_and_non_numbers_are_refused() -> None:
    for bad in (Decimal("NaN"), Decimal("Infinity"), float("nan"), True, [1], {}, b"1"):
        with pytest.raises(ValueError):
            parse_decimal(bad)


def test_parse_json_object_refuses_non_objects_and_garbage() -> None:
    for bad in ("[1]", "1", "{", b"\xff"):
        with pytest.raises(ValueError):
            parse_json_object(bad)


def test_coerce_decimal_fields_names_the_bad_field() -> None:
    dto = {"amount": "12.50", "note": None, "label": "x"}
    assert coerce_decimal_fields(dto, frozenset({"amount", "note"})) == {
        "amount": Decimal("12.5"), "note": None, "label": "x",
    }
    with pytest.raises(ValueError, match="amount"):
        coerce_decimal_fields({"amount": "abc"}, frozenset({"amount"}))


def test_to_wire_canonicalises_every_decimal_in_a_response() -> None:
    assert to_wire({"rows": [{"a": Decimal("12.50"), "n": None, "i": 3}], "total": 1}) == {
        "rows": [{"a": "12.5", "n": None, "i": 3}], "total": 1,
    }
    assert to_wire(Decimal("0E-18")) == "0"


# --- W3: the column's range ---------------------------------------------------------------


@pytest.mark.parametrize(
    "text,ok",
    [
        ("12345678901234567.8901234567", True),   # 18 integer + 10 fraction digits in (28, 10)
        ("0.1234567890", True),
        ("0.12345678901", False),                  # 11th fraction digit
        ("1234567890123456789", False),            # 19 integer digits
        ("100.2500", True),                        # trailing zeros do not count
        ("1.5e1", True),
        ("-0.0000000001", True),
        ("0", True),
        ("1e19", False),
    ],
)
def test_w3_range_is_enforced_and_nothing_is_rounded(text: str, ok: bool) -> None:
    from metaobjects.codegen.runtime.decimal_wire import coerce_decimal_fields

    fields = frozenset({"amount"})
    limits = {"amount": (28, 10)}
    if ok:
        assert coerce_decimal_fields({"amount": text}, fields, limits)["amount"] == Decimal(text)
    else:
        with pytest.raises(ValueError):
            coerce_decimal_fields({"amount": text}, fields, limits)


def test_a_decimal_array_is_coerced_and_range_checked_element_by_element() -> None:
    # ADR-0019 Amendment 1 over a ``field.decimal`` declared ``isArray``: each element is read
    # exactly (W2), held to the column's range (W3), and leaves as its canonical string (W1).
    fields = frozenset({"readings"})
    limits = {"readings": (9, 4)}
    coerced = coerce_decimal_fields({"readings": ["100.5000", 2.5, "1.5e1", None]}, fields, limits)
    assert to_wire(coerced) == {"readings": ["100.5", "2.5", "15", None]}
    assert coerce_decimal_fields({"readings": []}, fields, limits) == {"readings": []}
    for bad in (["1", "0.12345"], ["100000"], ["1", "12abc"], [True]):
        with pytest.raises(ValueError, match="readings"):
            coerce_decimal_fields({"readings": bad}, fields, limits)
