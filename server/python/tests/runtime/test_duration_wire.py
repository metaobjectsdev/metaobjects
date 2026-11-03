"""The Python half of the field.duration wire rule against the shared vectors
(``fixtures/duration-wire/vectors.json``), through the production helper."""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import pytest

from metaobjects.codegen.runtime.duration_wire import (
    canonical_duration,
    duration_from_driver,
    format_duration,
    format_postgres_interval,
    is_duration_literal,
    parse_duration,
    parse_duration_input,
    parse_postgres_interval,
)

_VECTORS = json.loads(
    (Path(__file__).resolve().parents[4] / "fixtures" / "duration-wire" / "vectors.json").read_text()
)


@pytest.mark.parametrize("v", _VECTORS["parse"], ids=lambda v: v["in"])
def test_parse_answers_the_canonical_form(v: dict[str, str]) -> None:
    assert is_duration_literal(v["in"])
    assert canonical_duration(v["in"]) == v["out"]
    assert format_duration(parse_duration(v["in"])) == v["out"]
    # The canonical form is a fixed point, and what a text column holds reads back as written.
    assert canonical_duration(v["out"]) == v["out"]
    assert format_duration(duration_from_driver(v["out"])) == v["out"]


@pytest.mark.parametrize("text", _VECTORS["refused"], ids=lambda t: repr(t))
def test_refused_is_not_a_duration(text: str) -> None:
    assert not is_duration_literal(text)
    assert canonical_duration(text) is None
    with pytest.raises(ValueError):
        parse_duration(text)
    with pytest.raises(ValueError):
        parse_duration_input(text)


@pytest.mark.parametrize("v", _VECTORS["postgres"], ids=lambda v: v["in"])
def test_postgres_interval_text_reads_as_canonical(v: dict[str, str]) -> None:
    assert format_duration(parse_postgres_interval(v["in"])) == v["out"]
    assert format_duration(duration_from_driver(v["in"])) == v["out"]


@pytest.mark.parametrize("text", _VECTORS["postgresRefused"], ids=lambda t: t)
def test_postgres_interval_with_a_month_part_is_refused(text: str) -> None:
    with pytest.raises(ValueError):
        parse_postgres_interval(text)
    with pytest.raises(ValueError):
        duration_from_driver(text)


@pytest.mark.parametrize("v", _VECTORS["postgresText"], ids=lambda v: v["in"])
def test_postgres_text_spelling(v: dict[str, str]) -> None:
    assert format_postgres_interval(parse_duration(v["in"])) == v["out"]
    # Postgres returns an interval written this way in exactly this spelling.
    assert format_duration(parse_postgres_interval(v["out"])) == v["in"]


def test_a_native_timedelta_is_formatted_canonically() -> None:
    assert format_duration(dt.timedelta(minutes=90)) == "PT1H30M"
    assert format_duration(dt.timedelta(seconds=-90)) == "-PT1M30S"
    assert format_duration(dt.timedelta(days=1, seconds=-1)) == "PT23H59M59S"
    assert format_duration(dt.timedelta(0)) == "PT0S"
    assert format_duration(dt.timedelta(microseconds=1)) == "PT0.000001S"
    assert duration_from_driver(dt.timedelta(hours=2)) == dt.timedelta(hours=2)


def test_a_pg8000_interval_with_a_month_part_is_refused() -> None:
    pg8000_types = pytest.importorskip("pg8000.types")
    with pytest.raises(ValueError, match="year or month part"):
        duration_from_driver(pg8000_types.PGInterval(months=1, days=2))
    assert format_duration(duration_from_driver(pg8000_types.PGInterval(days=1, hours=2))) == "PT26H"


@pytest.mark.parametrize("value", [90, 1.5, True, None, ["PT1H"]], ids=repr)
def test_a_non_string_input_is_not_a_duration(value: object) -> None:
    with pytest.raises(ValueError):
        parse_duration_input(value)


def test_an_out_of_range_duration_is_a_value_error() -> None:
    with pytest.raises(ValueError):
        parse_duration("PT99999999999999999999H")


def test_a_timedelta_past_the_bound_is_refused_on_input_and_on_read() -> None:
    edge = dt.timedelta(hours=256_204_778)
    assert duration_from_driver(edge) == edge
    assert parse_duration_input(-edge) == -edge
    over = edge + dt.timedelta(microseconds=1)
    for value in (over, -over):
        with pytest.raises(ValueError, match="out of range"):
            duration_from_driver(value)
        with pytest.raises(ValueError, match="out of range"):
            parse_duration_input(value)
