"""The closed expression grammar's functions and casts (C2): every function and the cast node
validate and infer as the TypeScript reference does, and a CHECK condition refuses what only a
view can hold. The shared corpus pins the loader errors; this pins the rules one by one."""
from __future__ import annotations

import pytest

from metaobjects.loader.validation_passes import (
    EXPR_FUNCTIONS,
    cast_problem,
    expr_view_only_node,
    infer_expr_type,
    validate_expr_node,
)

_FIELDS = {
    "s": "string", "t": "string", "n": "int", "big": "long", "d": "decimal", "b": "boolean",
    "when": "timestamp", "day": "date", "status": "enum", "code": "enum", "blob": "object",
}


def _infer(node: object, int_enums: frozenset[str] = frozenset({"code"})):
    return infer_expr_type(node, _FIELDS.get, lambda name: name in int_enums)


def _fn(name: str, *args: object) -> dict:
    return {"fn": name, "args": list(args)}


def _f(name: str) -> dict:
    return {"field": name}


def _v(value: object) -> dict:
    return {"value": value}


def test_every_function_is_known_and_arity_checked() -> None:
    assert set(EXPR_FUNCTIONS) == {
        "coalesce", "greatest", "least", "nullif", "lower", "upper", "btrim", "splitPart",
        "concat", "concatWs", "substring", "replace", "left", "right", "length",
    }
    assert validate_expr_node(_fn("lower", _f("s"))) == []
    assert validate_expr_node(_fn("nope", _f("s"))) == ["unknown expression fn 'nope'"]
    assert validate_expr_node(_fn("splitPart", _f("s"), _v("-"))) == ["'splitPart' requires at least 3 args"]
    assert validate_expr_node(_fn("lower", _f("s"), _f("t"))) == ["'lower' takes at most 1 args, got 2"]
    assert validate_expr_node({"fn": "lower"}) == ["'lower' requires a non-empty args array"]


@pytest.mark.parametrize(
    ("node", "type_"),
    [
        (_fn("lower", _f("s")), "string"),
        (_fn("length", _f("s")), "int"),
        (_fn("concat", _f("s"), _f("n"), _f("d")), "string"),
        (_fn("concatWs", _v("-"), _f("s"), _f("n")), "string"),
        (_fn("splitPart", _f("s"), _v("-"), _v(1)), "string"),
        (_fn("substring", _f("s"), _f("n")), "string"),
        (_fn("greatest", _f("when"), _f("when")), "timestamp"),
        (_fn("nullif", _f("s"), _v("")), "string"),
        (_fn("coalesce", _f("d"), _v(0)), "decimal"),
    ],
)
def test_functions_type_cleanly(node: object, type_: str) -> None:
    result = _infer(node)
    assert result.errors == []
    assert result.type == type_


def test_function_argument_kinds_are_enforced() -> None:
    assert _infer(_fn("lower", _f("n"))).errors == ["'lower' argument 1 must be a string, got int"]
    assert _infer(_fn("left", _f("s"), _f("big"))).errors == [
        "'left' argument 2 must be an int, got long; cast it ({ cast: <expr>, as: int })"
    ]
    assert _infer(_fn("concat", _f("blob"))).errors == ["'concat' argument 1 must be a scalar, got object"]
    assert _infer(_fn("nullif", _f("s"), _f("n"))).errors == [
        "'nullif' arguments have differing types (string, int)"
    ]
    assert _infer(_fn("greatest", _f("b"), _f("b"))).errors == ["'greatest' needs ordered arguments, got boolean"]


def test_a_null_literal_fits_any_parameter() -> None:
    result = _infer(_fn("lower", _v(None)))
    assert (result.type, result.errors) == ("string", [])


def test_cast_validates_its_shape() -> None:
    assert validate_expr_node({"cast": _f("n"), "as": "string"}) == []
    assert validate_expr_node({"cast": _f("n")})[0].startswith("'cast' requires 'as': one of string, int")
    assert validate_expr_node({"cast": _f("n"), "as": "currency"})[0].startswith("'cast' requires 'as'")
    assert validate_expr_node({"cast": _f("n"), "as": "int", "x": 1}) == [
        "expression 'cast' takes only 'as' and 'dbColumnType' beside it, not x"
    ]
    ok = {"cast": _f("n"), "as": "string", "dbColumnType": "varchar(10)"}
    assert validate_expr_node(ok) == []
    for bad in (
        {"cast": _f("n"), "as": "string", "dbColumnType": "uuid"},
        {"cast": _f("n"), "as": "int", "dbColumnType": "text"},
        {"cast": _f("n"), "as": "string", "dbColumnType": "citext"},
    ):
        assert validate_expr_node(bad)[0].startswith("'cast' 'dbColumnType' is a text spelling")
    assert validate_expr_node({"cast": {"fn": "nope", "args": [_f("n")]}, "as": "int"}) == [
        "unknown expression fn 'nope'"
    ]


def test_cast_types_to_its_target_and_applies_the_table() -> None:
    assert _infer({"cast": _f("n"), "as": "string"}).type == "string"
    assert _infer({"cast": _f("n"), "as": "decimal"}).errors == []
    assert _infer({"cast": _v(None), "as": "string"}).errors == []
    assert _infer({"cast": _f("blob"), "as": "string"}).errors == ["'cast': a field.object value cannot be cast"]
    assert _infer({"cast": _f("d"), "as": "boolean"}).errors == [
        "'cast': a decimal cannot be cast to boolean; only an int can"
    ]
    assert _infer({"cast": _f("b"), "as": "decimal"}).errors == ["'cast': a boolean casts only to int, not decimal"]
    assert _infer({"cast": _f("n"), "as": "date"}).errors == ["'cast': a int cannot be cast to date"]


def test_an_enum_casts_by_how_it_is_stored() -> None:
    assert _infer({"cast": _f("code"), "as": "int"}).errors == []
    assert _infer({"cast": _f("status"), "as": "int"}).errors == [
        "'cast': only an enum stored as an integer (@intValueMap) can be cast to a number"
    ]
    assert _infer({"cast": _f("status"), "as": "string"}).errors == []
    assert _infer({"cast": _f("code"), "as": "string"}).errors[0].startswith(
        "'cast': an int-stored enum (@intValueMap) cast to string gives its integer"
    )
    assert _infer({"cast": _f("status"), "as": "boolean"}).errors == ["'cast': an enum cannot be cast to boolean"]


def test_cast_problem_table() -> None:
    assert cast_problem(None, "int", False) is None
    assert cast_problem("string", "uuid", False) is None
    assert cast_problem("timestamp", "date", False) is None
    assert cast_problem("int", "boolean", False) is None
    assert cast_problem("uuid", "int", False) == "a uuid cannot be cast to int"


def test_a_check_condition_refuses_what_only_a_view_holds() -> None:
    assert expr_view_only_node(_fn("coalesce", _f("n"), _v(0))) is None
    assert expr_view_only_node({"op": "gt", "left": _f("n"), "right": _v(0)}) is None
    assert expr_view_only_node({"op": "gt", "left": _fn("length", _f("s")), "right": _v(0)}) == "length"
    assert expr_view_only_node({"op": "isNull", "arg": {"cast": _f("n"), "as": "string"}}) == "cast"
    assert expr_view_only_node({"op": "eq", "left": _f("customer.zip"), "right": _v("1")}) == (
        'the path "customer.zip"'
    )
