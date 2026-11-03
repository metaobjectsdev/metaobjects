"""The Python half of the field.duration wire rule against the shared vectors
(``fixtures/duration-wire/vectors.json``), through the production helper: every ``wire`` group,
and the ``codecs`` groups this port has in production code -- ``postgres`` and
``postgresRefused`` (the interval text a JSON value holds once Postgres has written it, and the
pg8000 ``PGInterval`` path) and ``storedMicros`` (SQLite and MySQL). ``postgresText`` is not run:
pg8000 binds a ``timedelta`` natively, so this port never spells an interval as text."""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import pytest

from metaobjects.codegen.runtime.duration_wire import (
    canonical_duration,
    duration_from_driver,
    format_duration,
    from_stored_micros,
    is_duration_literal,
    micros_of,
    parse_duration,
    parse_duration_input,
    parse_postgres_interval,
    to_stored_micros,
)

_VECTORS = json.loads(
    (Path(__file__).resolve().parents[4] / "fixtures" / "duration-wire" / "vectors.json").read_text()
)
_WIRE = _VECTORS["wire"]
_CODECS = _VECTORS["codecs"]
#: The ``wire.precision`` entry this port checks: a ``timedelta`` holds microseconds.
_PRECISION_KEY = "6"


@pytest.mark.parametrize("v", _WIRE["parse"], ids=lambda v: v["in"])
def test_parse_answers_the_canonical_form(v: dict[str, str]) -> None:
    assert is_duration_literal(v["in"])
    assert canonical_duration(v["in"]) == v["out"]
    assert format_duration(parse_duration(v["in"])) == v["out"]
    # The canonical form is a fixed point, and what a text column holds reads back as written.
    assert canonical_duration(v["out"]) == v["out"]
    assert format_duration(duration_from_driver(v["out"])) == v["out"]


@pytest.mark.parametrize("text", _WIRE["refused"], ids=lambda t: repr(t))
def test_refused_is_not_a_duration(text: str) -> None:
    assert not is_duration_literal(text)
    assert canonical_duration(text) is None
    with pytest.raises(ValueError):
        parse_duration(text)
    with pytest.raises(ValueError):
        parse_duration_input(text)


@pytest.mark.parametrize("v", _CODECS["postgres"], ids=lambda v: v["in"])
def test_postgres_interval_text_reads_as_canonical(v: dict[str, str]) -> None:
    assert format_duration(parse_postgres_interval(v["in"])) == v["out"]
    assert format_duration(duration_from_driver(v["in"])) == v["out"]


@pytest.mark.parametrize("text", _CODECS["postgresRefused"], ids=lambda t: t)
def test_postgres_interval_with_a_month_part_is_refused(text: str) -> None:
    with pytest.raises(ValueError):
        parse_postgres_interval(text)
    with pytest.raises(ValueError):
        duration_from_driver(text)


@pytest.mark.parametrize("v", _WIRE["precision"], ids=lambda v: v["in"])
def test_a_fraction_of_any_length_is_truncated_to_microseconds(v: dict[str, object]) -> None:
    out = v["out"][_PRECISION_KEY]  # type: ignore[index]
    assert is_duration_literal(v["in"])  # type: ignore[arg-type]
    assert canonical_duration(v["in"]) == out  # type: ignore[arg-type]
    assert format_duration(parse_duration(v["in"])) == out  # type: ignore[arg-type]


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


@pytest.mark.parametrize("v", _CODECS["storedMicros"], ids=lambda v: v["in"])
def test_stored_micros(v: dict[str, str]) -> None:
    td = parse_duration(v["in"])
    assert to_stored_micros(td) == int(v["out"])
    # What the column holds reads back as the input, less the digits a microsecond count drops.
    stored = format_duration(from_stored_micros(int(v["out"])))
    assert stored == canonical_duration(v["in"])
    assert format_duration(duration_from_driver(int(v["out"]))) == stored


# ── this port's own limits (not shared vectors) ──────────────────────────────


def test_the_timedelta_range_is_the_only_limit_and_past_it_is_refused() -> None:
    # Far past what another port's native type holds: Python takes it.
    assert format_duration(parse_duration("PT256204779H")) == "PT256204779H"
    edge = f"P{999_999_999}DT23H59M59.999999S"
    assert parse_duration(edge) == dt.timedelta.max
    assert parse_duration(f"-P{999_999_999}D") == dt.timedelta.min
    for text in (f"P{1_000_000_000}D", f"P{999_999_999}DT24H", f"-P{999_999_999}DT0.000001S"):
        assert not is_duration_literal(text)
        assert canonical_duration(text) is None
        with pytest.raises(ValueError, match="out of range"):
            parse_duration(text)
    with pytest.raises(ValueError, match="out of range"):
        from_stored_micros(micros_of(dt.timedelta.max) + 1)


def test_a_stored_micro_count_past_64_bits_is_refused() -> None:
    assert to_stored_micros(dt.timedelta(microseconds=2**63 - 1)) == 2**63 - 1
    assert to_stored_micros(dt.timedelta(microseconds=-(2**63))) == -(2**63)
    for td in (dt.timedelta(microseconds=2**63), dt.timedelta(microseconds=-(2**63) - 1), dt.timedelta.max):
        with pytest.raises(ValueError, match="64-bit"):
            to_stored_micros(td)


def test_a_bool_is_not_a_stored_micro_count() -> None:
    with pytest.raises(ValueError):
        duration_from_driver(True)
