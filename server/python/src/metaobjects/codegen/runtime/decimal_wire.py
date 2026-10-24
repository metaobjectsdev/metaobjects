"""The decimal wire rule (ADR-0019 Amendment 1, W1-W4) for the generated REST surface.

One production helper, used by the generated routers and tested against the shared vectors
(``fixtures/decimal-wire/vectors.json``):

* **W1, emit** -- :func:`format_decimal` / :func:`to_wire`: every ``Decimal`` leaves as a JSON
  string in canonical form (plain notation, no exponent, no trailing fractional zeros, zero is
  ``"0"``).
  Which form leaves is the project's ``wire`` setting (:func:`render_wire`): ``string`` is W1,
  ``native`` is :func:`to_native`.
* **W2, accept** -- :func:`parse_decimal` (a request-body value) and :func:`parse_decimal_operand`
  (a filter operand): a string in the JSON-number grammar, or a JSON number; anything else is a
  ``ValueError``. Nothing goes through a ``float``: :func:`parse_json_object` reads a body with
  ``parse_float=Decimal``.
* **W3, range** -- a value too large to render is refused, never rounded.
* **W4, SQLite** -- :func:`decimal_from_double15`: a double read from an engine with no decimal
  type is exact to 15 significant digits.
"""
from __future__ import annotations

import dataclasses
import json
import re
from decimal import Context, Decimal, InvalidOperation
from typing import Any, Callable, Iterable

#: A string body value and a filter operand: the JSON-number grammar. An exponent is allowed on
#: input only. No sign other than ``-``, no leading zeros, no bare point, no whitespace.
_JSON_NUMBER = re.compile(r"-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?")

#: W3: the widest plain-notation rendering a value may have. A string like ``1e999999999`` is
#: syntactically a number but would render as a gigabyte; it is out of range.
MAX_DIGITS = 1000


_EXACT = Context(prec=MAX_DIGITS * 2 + 64)


def _normalize(value: Decimal) -> Decimal:
    """``Decimal.normalize`` rounds to the context precision (28 digits); an unbounded decimal
    must not lose digits, so normalize under a context wide enough for any in-range value."""
    return value.normalize(_EXACT)


def format_decimal(value: Decimal) -> str:
    """W1: the canonical wire string of *value*."""
    if not value.is_finite():
        raise ValueError(f"{value} is not a finite decimal")
    if value == 0:
        return "0"
    normalized = _normalize(value)
    if abs(normalized.adjusted()) > MAX_DIGITS:
        raise ValueError("decimal out of range")
    return format(normalized, "f")


def _checked(value: Decimal) -> Decimal:
    if abs(value.adjusted()) > MAX_DIGITS and value != 0:
        raise ValueError("decimal out of range")
    return value


def parse_decimal(value: Any) -> Decimal:
    """W2: a request-body decimal (a JSON string or number) as an exact ``Decimal``.

    ``bool`` is not a number here, and neither is anything that is not a string or a number.
    A ``float`` (a body not read with ``parse_float=Decimal``) is taken as the decimal it was
    written as, which is exact to 15 significant digits.
    """
    if isinstance(value, bool):
        raise ValueError("a boolean is not a decimal")
    if isinstance(value, Decimal):
        return _checked(value) if value.is_finite() else _reject()
    if isinstance(value, int):
        return _checked(Decimal(value))
    if isinstance(value, float):
        return _checked(Decimal(repr(value))) if value == value and abs(value) != float("inf") else _reject()
    if isinstance(value, str):
        return _parse_text(value)
    raise ValueError(f"{type(value).__name__} is not a decimal")


def parse_decimal_operand(text: str) -> Decimal:
    """W2: a filter operand (query-string text) as an exact ``Decimal``."""
    return _parse_text(text)


def _reject() -> Decimal:
    raise ValueError("not a finite decimal")


def _parse_text(text: str) -> Decimal:
    if _JSON_NUMBER.fullmatch(text) is None:
        raise ValueError(f"{text!r} is not a decimal")
    try:
        return _checked(Decimal(text))
    except InvalidOperation:
        raise ValueError(f"{text!r} is not a decimal") from None


def decimal_from_double15(value: float | str) -> Decimal:
    """W4: the stored double *value* rendered at 15 significant digits (SQLite's own text
    precision), as a ``Decimal``. ``sum(0.1, 0.2)`` reads ``0.3``."""
    as_float = float(value)
    if as_float != as_float or as_float in (float("inf"), float("-inf")):
        raise ValueError(f"{value!r} is not a finite decimal")
    return Decimal(f"{as_float:.15g}")


def parse_json_object(body: bytes | str) -> dict[str, Any]:
    """A request body as a JSON object, every non-integer number as an exact ``Decimal``.

    Raises ``ValueError`` for invalid JSON or a body that is not an object."""
    try:
        parsed = json.loads(body, parse_float=Decimal)
    except (json.JSONDecodeError, UnicodeDecodeError, RecursionError) as exc:
        raise ValueError("invalid JSON") from exc
    if not isinstance(parsed, dict):
        raise ValueError("a JSON object is required")
    return parsed


def check_decimal_range(value: Decimal, precision: int, scale: int) -> None:
    """W3: raise ``ValueError`` when *value* cannot be held by ``DECIMAL(precision, scale)``
    -- more fraction digits than *scale* or more integer digits than ``precision - scale``.
    Trailing fraction zeros do not count (``100.2500`` is ``100.25``); nothing is rounded."""
    d = _normalize(value)
    exponent = d.as_tuple().exponent
    if not isinstance(exponent, int):
        raise ValueError("not a finite number")
    if -exponent > scale:
        raise ValueError(f"more than {scale} fraction digit(s)")
    integer_digits = max(d.adjusted() + 1, 0) if d != 0 else 0
    if integer_digits > precision - scale:
        raise ValueError(f"more than {precision - scale} integer digit(s)")


def coerce_decimal_fields(
    dto: dict[str, Any],
    decimal_fields: frozenset[str],
    limits: dict[str, tuple[int, int]] | None = None,
    nested: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """A copy of *dto* with each present decimal field parsed under W2 (``null`` stays
    ``None``) and held to its column's range under W3 (*limits*: name to (precision, scale)).
    A list (a decimal declared ``isArray``) is parsed and range-checked element by element.
    Raises ``ValueError`` naming the field when one is malformed or out of range."""
    # parse_json_object reads EVERY non-integer number as a Decimal; only a declared decimal
    # field keeps it. A double/float field, or a number inside a jsonb value object, goes back
    # to the float a JSON number is for them (json.dumps cannot serialize a Decimal).
    nested = nested or {}
    out: dict[str, Any] = {}
    for k, v in dto.items():
        if k in decimal_fields:
            out[k] = v
        elif k in nested:
            out[k] = _nested(v, nested[k], k)
        else:
            out[k] = _floats(v)
    for name in decimal_fields:
        if name in out and out[name] is not None:
            limit = limits.get(name) if limits else None
            try:
                value = out[name]
                out[name] = (
                    [None if v is None else _coerce_decimal(v, limit) for v in value]
                    if isinstance(value, list)
                    else _coerce_decimal(value, limit)
                )
            except ValueError as exc:
                raise ValueError(f"{name}: {exc}") from None
    return out


def _nested(value: Any, spec: dict[str, Any], path: str) -> Any:
    """A jsonb value-object field (*value* a dict, or a list of them) under the top-level
    decimal rule: each declared decimal inside is parsed under W2, held to its range under W3
    (*spec*: ``{"d": {name: (precision, scale) | None}, "o": {name: spec}}``, or ``{"m": spec}`` for a
    ``field.map`` of value objects, applied to each value) and stored as its
    canonical string; every other number is a float. Raises ``ValueError`` naming the path."""
    if isinstance(value, list):
        return [_nested(v, spec, path) for v in value]
    if not isinstance(value, dict):
        return _floats(value)
    if "m" in spec:
        # a field.map of value objects: the spec applies to EACH value; keys are arbitrary
        # text and never matched against member names.
        return {k: _nested(v, spec["m"], f"{path}.{k}") for k, v in value.items()}
    out: dict[str, Any] = {}
    for k, v in value.items():
        if k in spec["d"] and v is not None:
            limit = spec["d"][k]
            try:
                out[k] = [None if e is None else _canonical(e, limit) for e in v] if isinstance(v, list) else _canonical(v, limit)
            except ValueError as exc:
                raise ValueError(f"{path}.{k}: {exc}") from None
        elif k in spec["o"]:
            out[k] = _nested(v, spec["o"][k], f"{path}.{k}")
        else:
            out[k] = _floats(v)
    return out


def _canonical(value: Any, limit: tuple[int, int] | None) -> str:
    return format_decimal(_coerce_decimal(value, limit))


def _floats(value: Any) -> Any:
    """*value* with every ``Decimal`` (at any depth of a dict or list) as a ``float``."""
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, dict):
        return {k: _floats(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_floats(v) for v in value]
    return value


def _coerce_decimal(value: Any, limit: tuple[int, int] | None) -> Decimal:
    parsed = parse_decimal(value)
    if limit is not None:
        check_decimal_range(parsed, *limit)
    return parsed


def coerce_decimal_predicates(
    predicates: Iterable[Any], decimal_fields: frozenset[str]
) -> tuple[list[Any], dict[str, str] | None]:
    """W2 for a filter: each predicate (a dataclass with ``field`` / ``op`` / ``value``, the
    shape ``filter_parser.parse_filter`` returns) on a decimal field has its operand parsed
    exactly, so a repository compares a ``Decimal``, never a float or text. Returns
    ``(predicates, None)``, or ``([], envelope)`` where *envelope* is the corpus's existing
    ``invalid_filter_value`` body naming the first malformed field."""
    out: list[Any] = []
    for p in predicates:
        if p.field in decimal_fields and p.op != "isNull":
            try:
                value = (
                    [parse_decimal_operand(v) for v in p.value]
                    if isinstance(p.value, list)
                    else parse_decimal_operand(p.value)
                )
            except ValueError:
                return [], {"error": "invalid_filter_value", "field": p.field}
            p = dataclasses.replace(p, value=value)
        out.append(p)
    return out, None


def _render(value: Any, decimal: Callable[[Decimal], str]) -> Any:
    """*value* with every ``Decimal`` (at any depth of a dict, list or Pydantic model) as the
    string *decimal* makes of it; everything else is left for the framework's encoder."""
    if isinstance(value, Decimal):
        return decimal(value)
    if isinstance(value, dict):
        return {k: _render(v, decimal) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_render(v, decimal) for v in value]
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        return _render(dump(), decimal)
    return value


def to_wire(value: Any) -> Any:
    """W1 over a whole response: every ``Decimal`` in *value* (a row, a list of rows, the
    ``{"rows", "total"}`` envelope, a Pydantic model) as its canonical string."""
    return _render(value, format_decimal)


def to_native(value: Any) -> Any:
    """The ``native`` decimal form over a whole response: every ``Decimal`` as ``str(value)``,
    which is what Pydantic v2 writes for one and keeps the value's scale (``Decimal("12.50")``
    is ``"12.50"``). FastAPI's own encoder would turn a ``Decimal`` in a plain dict row into a
    ``float``, which is lossy; a string is the exact form."""
    return _render(value, str)


@dataclasses.dataclass(frozen=True)
class WireOutput:
    """The ``wire`` project setting (ADR-0019 Amendment 2) a generated router writes with.

    *decimals* is ``native`` or ``string``; *null_members* is ``native``, ``emit`` or ``omit``.
    *shapes* names, per value-object field of the entity, its declared members:
    ``{"f": [member, ...], "o": {member: shape}}``, or ``{"m": shape}`` for a ``field.map`` of
    value objects (the shape applies to each value)."""

    decimals: str = "native"
    null_members: str = "native"
    shapes: dict[str, Any] = dataclasses.field(default_factory=dict)


def render_wire(value: Any, wire: WireOutput) -> Any:
    """A response *value* (a row, a list of rows, a Pydantic model) in the form *wire* asks
    for. Input rules do not depend on *wire*."""
    if wire.null_members != "native" and wire.shapes:
        value = _shape_members(value, wire)
    return to_wire(value) if wire.decimals == "string" else to_native(value)


def _shape_members(value: Any, wire: WireOutput) -> Any:
    """Apply ``omit`` / ``emit`` to the value-object fields of every row in *value*. A row's
    other fields (a top-level ``null`` among them) are untouched."""
    if isinstance(value, (list, tuple)):
        return [_shape_members(v, wire) for v in value]
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        value = dump()
    if not isinstance(value, dict):
        return value
    out: dict[str, Any] = {}
    for k, v in value.items():
        out[k] = _shape_vo(v, wire.shapes[k], wire.null_members) if k in wire.shapes else v
    return out


def _shape_vo(value: Any, shape: dict[str, Any], mode: str) -> Any:
    if isinstance(value, list):
        return [_shape_vo(v, shape, mode) for v in value]
    if not isinstance(value, dict):
        return value
    if "m" in shape:
        return {k: _shape_vo(v, shape["m"], mode) for k, v in value.items()}
    members = {k: _shape_vo(v, shape["o"][k], mode) if k in shape["o"] else v for k, v in value.items()}
    if mode == "omit":
        return {k: v for k, v in members.items() if v is not None}
    return {**{name: None for name in shape["f"]}, **members}
