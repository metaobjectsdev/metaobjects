"""The validation envelope every generated write route answers with (400, every issue listed)."""
from __future__ import annotations

from decimal import Decimal
from typing import Annotated

import pytest
from pydantic import BaseModel, Field, ValidationError

from metaobjects.codegen.runtime.constraint_errors import (
    pydantic_issues,
    required_null_issues,
    unreadable_body_issues,
    value_error_issues,
    validation_envelope,
)
from metaobjects.codegen.runtime.decimal_wire import coerce_decimal_fields


@pytest.mark.parametrize(
    ("error_type", "code"),
    [
        ("missing", "invalid_type"),
        ("string_type", "invalid_type"),
        ("int_type", "invalid_type"),
        ("model_type", "invalid_type"),
        ("int_parsing", "invalid_type"),
        ("float_parsing", "invalid_type"),
        ("bool_parsing", "invalid_type"),
        ("decimal_parsing", "invalid_type"),
        ("int_from_float", "invalid_type"),
        ("string_too_long", "too_big"),
        ("too_long", "too_big"),
        ("less_than", "too_big"),
        ("less_than_equal", "too_big"),
        ("decimal_max_digits", "too_big"),
        ("decimal_max_places", "too_big"),
        ("decimal_whole_digits", "too_big"),
        ("string_too_short", "too_small"),
        ("too_short", "too_small"),
        ("greater_than", "too_small"),
        ("greater_than_equal", "too_small"),
        ("string_pattern_mismatch", "invalid_format"),
        ("date_parsing", "invalid_format"),
        ("datetime_parsing", "invalid_format"),
        ("time_parsing", "invalid_format"),
        ("uuid_parsing", "invalid_format"),
        ("date_from_datetime_inexact", "invalid_format"),
        ("enum", "invalid_value"),
        ("literal_error", "invalid_value"),
        ("multiple_of", "not_multiple_of"),
        ("extra_forbidden", "unrecognized_keys"),
        ("value_error", "custom"),
        ("assertion_error", "custom"),
        ("something_new", "custom"),
    ],
)
def test_pydantic_error_type_maps_to_a_zod_code(error_type: str, code: str) -> None:
    [issue] = pydantic_issues([{"type": error_type, "loc": ("f",), "msg": "m"}])
    assert issue == {"code": code, "path": ["f"], "message": "m"}


class _Inner(BaseModel):
    note: Annotated[str, Field(max_length=3)]


class _Outer(BaseModel):
    name: Annotated[str, Field(max_length=3)]
    age: int
    inner: _Inner
    tags: list[Annotated[str, Field(min_length=2)]]


def test_real_pydantic_errors_list_every_issue_with_wire_paths() -> None:
    with pytest.raises(ValidationError) as caught:
        _Outer(**{"name": "toolong", "age": "x", "inner": {"note": "abcd"}, "tags": ["a"]})
    issues = pydantic_issues(caught.value.errors())
    got = {(tuple(i["path"]), i["code"]) for i in issues}
    assert got == {
        (("name",), "too_big"),
        (("age",), "invalid_type"),
        (("inner", "note"), "too_big"),
        (("tags", 0), "too_small"),
    }
    assert all(isinstance(i["message"], str) and i["message"] for i in issues)


def test_a_missing_required_field_is_invalid_type() -> None:
    with pytest.raises(ValidationError) as caught:
        _Outer(**{"name": "ok"})
    assert {(tuple(i["path"]), i["code"]) for i in pydantic_issues(caught.value.errors())} >= {
        (("age",), "invalid_type"),
        (("inner",), "invalid_type"),
    }


def test_required_null_issues_are_sorted_and_only_for_present_nulls() -> None:
    dto = {"b": None, "a": None, "c": None, "d": 1}
    issues = required_null_issues(dto, frozenset({"a", "b", "d", "e"}))
    assert [(i["path"], i["code"]) for i in issues] == [(["a"], "invalid_type"), (["b"], "invalid_type")]


def test_unreadable_body_has_an_empty_path() -> None:
    [issue] = unreadable_body_issues()
    assert issue["path"] == [] and issue["code"] == "invalid_type"


def test_envelope_dedupes_on_path_and_code() -> None:
    a = {"code": "invalid_type", "path": ["x"], "message": "one"}
    b = {"code": "invalid_type", "path": ["x"], "message": "two"}
    c = {"code": "too_big", "path": ["x"], "message": "three"}
    assert validation_envelope([a, b, c]) == {"error": "validation", "issues": [a, c]}


def test_decimal_failures_carry_a_wire_path_and_code() -> None:
    with pytest.raises(ValueError) as unparseable:
        coerce_decimal_fields({"amount": "abc"}, frozenset({"amount"}))
    [issue] = value_error_issues(unparseable.value)
    assert (issue["path"], issue["code"]) == (["amount"], "invalid_type")

    with pytest.raises(ValueError) as too_big:
        coerce_decimal_fields({"amount": Decimal("1234.5")}, frozenset({"amount"}), {"amount": (5, 2)})
    [issue] = value_error_issues(too_big.value)
    assert (issue["path"], issue["code"]) == (["amount"], "too_big")


def test_a_nested_decimal_failure_names_its_member_path() -> None:
    spec = {"money": {"d": {"value": (5, 2)}, "o": {}}}
    with pytest.raises(ValueError) as caught:
        coerce_decimal_fields({"money": {"value": Decimal("123456.7")}}, frozenset(), None, spec)
    [issue] = value_error_issues(caught.value)
    assert (issue["path"], issue["code"]) == (["money", "value"], "too_big")


def test_a_plain_value_error_is_one_custom_issue_at_the_body() -> None:
    [issue] = value_error_issues(ValueError("boom"))
    assert issue == {"code": "custom", "path": [], "message": "boom"}
