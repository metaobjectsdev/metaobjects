"""The ``field.duration`` wire rule: a fixed-length span of time is an ISO-8601 duration on the
wire, and every port answers the same canonical form for it.

One production helper, used by the run-time (the ObjectManager's read and write codec and the
validator runner), the generated models and routers, and tested against the shared vectors
(``fixtures/duration-wire/vectors.json``). Standard library only, so an owned router can emit it.

* **Canonical** (what this port writes) -- :func:`format_duration`:
  ``[-]PT[<h>H][<m>M][<s>[.<f>]S]``. Hours are never folded into days, zero components are left
  out, zero is ``PT0S``, up to six fractional digits (a ``timedelta`` holds microseconds;
  trailing zeros are dropped), and a negative span has one leading ``-``.
* **Accepted** (what a caller may send) -- :func:`parse_duration`: an optional sign, ``P``,
  optional weeks (``W`` is exactly 7 days), optional days (``D`` is exactly 24 hours), then an
  optional ``T`` with hours, minutes and seconds in that order; at least one component. The
  seconds fraction may have any number of digits: the first six are kept and the rest truncated
  toward zero, never rounded. Years and months are refused: a calendar span has no fixed length.
* **Range** -- this port's own limit only: a ``timedelta`` spans at most 999999999 days either
  way. A duration past it is refused, never wrapped.
* **Stored micros** -- :func:`to_stored_micros` / :func:`from_stored_micros`: on SQLite, D1 and
  MySQL a duration is a 64-bit integer count of microseconds (the column's limit: past it is
  refused).
* **Postgres** -- pg8000 binds a ``timedelta`` natively as an ``interval`` and hands one back,
  or a ``PGInterval`` when the stored interval has a year or month part (it never guesses a
  month's length), which :func:`duration_from_driver` refuses. :func:`parse_postgres_interval`
  reads the default-style (``IntervalStyle = postgres``) text of an ``interval``, the spelling an
  interval has once Postgres has put it in a JSON value, under the same rule.
"""
from __future__ import annotations

import datetime as _dt
import re
from typing import Any

#: The accepted ISO-8601 duration form, byte-identical to the TS ``DURATION_PATTERN``.
DURATION_PATTERN = r"^[-+]?P(?!$)(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$"

# ``re.ASCII`` keeps ``\d`` to the ASCII digits, as JavaScript's ``\d`` is; ``fullmatch`` is used
# throughout because a Python ``$`` also matches before a trailing newline.
DURATION_RE = re.compile(DURATION_PATTERN, re.ASCII)

_PARTS_RE = re.compile(
    r"([-+])?P(?:([0-9]+)W)?(?:([0-9]+)D)?(?:T(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+)(?:\.([0-9]+))?S)?)?",
)

# The default-style text of an interval: signed year / mon / day parts, then an optionally
# signed ``H:MM:SS[.ffffff]``. Years and months are matched so they can be refused by name.
_PG_INTERVAL_RE = re.compile(
    r"(?:([-+]?[0-9]+) years? ?)?(?:([-+]?[0-9]+) mons? ?)?(?:([-+]?[0-9]+) days? ?)?"
    r"(?:([-+])?([0-9]+):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?)?",
)

_MICROS_PER_SECOND = 1_000_000
_MICROS_PER_MINUTE = 60 * _MICROS_PER_SECOND
_MICROS_PER_HOUR = 60 * _MICROS_PER_MINUTE
_MICROS_PER_DAY = 24 * _MICROS_PER_HOUR
_MICROS_PER_WEEK = 7 * _MICROS_PER_DAY

#: The range of a 64-bit integer column (SQLite INTEGER, MySQL BIGINT) holding microseconds.
_INT64_MIN = -(2**63)
_INT64_MAX = 2**63 - 1

#: The message a value that is not a duration is refused with (the run-time validator's text).
NOT_A_DURATION = "must be an ISO-8601 duration such as PT1H30M (no years or months)"


def is_duration_literal(text: str) -> bool:
    """True when *text* is an accepted ISO-8601 duration a ``timedelta`` can hold."""
    micros = _micros_of_literal(text)
    return micros is not None and _in_range(micros)


def _fraction_micros(digits: str | None) -> int:
    """Fractional-second digits, any number of them, as microseconds: the first six are kept
    and the rest truncated toward zero (the magnitude is truncated, so a negative span is too)."""
    if not digits:
        return 0
    return int(digits.ljust(6, "0")[:6])


def _micros_of_literal(text: str) -> int | None:
    if not isinstance(text, str) or DURATION_RE.fullmatch(text) is None:
        return None
    m = _PARTS_RE.fullmatch(text)
    if m is None:
        return None
    sign, w, d, h, mi, s, f = m.groups()
    magnitude = (
        int(w or 0) * _MICROS_PER_WEEK
        + int(d or 0) * _MICROS_PER_DAY
        + int(h or 0) * _MICROS_PER_HOUR
        + int(mi or 0) * _MICROS_PER_MINUTE
        + int(s or 0) * _MICROS_PER_SECOND
        + _fraction_micros(f)
    )
    return -magnitude if sign == "-" else magnitude


def micros_of(value: _dt.timedelta) -> int:
    """The exact microsecond count of *value*."""
    return (value.days * 86_400 + value.seconds) * _MICROS_PER_SECOND + value.microseconds


_MIN_MICROS = micros_of(_dt.timedelta.min)
_MAX_MICROS = micros_of(_dt.timedelta.max)


def _in_range(micros: int) -> bool:
    return _MIN_MICROS <= micros <= _MAX_MICROS


def _from_micros(micros: int) -> _dt.timedelta:
    """A ``timedelta`` of *micros* microseconds; past a ``timedelta``'s range is a ``ValueError``
    (refused, never wrapped)."""
    if not _in_range(micros):
        raise ValueError(
            f"the duration {_format_micros(micros)} is out of range: a Python timedelta spans at most "
            "999999999 days either way"
        )
    return _dt.timedelta(microseconds=micros)


def to_stored_micros(value: _dt.timedelta) -> int:
    """*value* as the 64-bit microsecond count a SQLite / D1 / MySQL column stores. Past the
    64-bit range (the column's limit) is a ``ValueError``."""
    micros = micros_of(value)
    if not _INT64_MIN <= micros <= _INT64_MAX:
        raise ValueError(
            f"the duration {_format_micros(micros)} is out of range for a 64-bit microsecond column"
        )
    return micros


def from_stored_micros(micros: int) -> _dt.timedelta:
    """The ``timedelta`` a stored microsecond count is."""
    return _from_micros(micros)


def parse_duration(text: str) -> _dt.timedelta:
    """An accepted ISO-8601 duration as a ``timedelta``. Anything else is a ``ValueError``."""
    micros = _micros_of_literal(text)
    if micros is None:
        raise ValueError(f"{text!r} is not an ISO-8601 duration (such as PT1H30M; no years or months)")
    return _from_micros(micros)


def format_duration(value: _dt.timedelta) -> str:
    """The canonical wire form of *value*."""
    return _format_micros(micros_of(value))


def _split(micros: int) -> tuple[bool, int, int, int, int]:
    negative = micros < 0
    rest = -micros if negative else micros
    h, rest = divmod(rest, _MICROS_PER_HOUR)
    m, rest = divmod(rest, _MICROS_PER_MINUTE)
    s, frac = divmod(rest, _MICROS_PER_SECOND)
    return negative, h, m, s, frac


def _fraction_text(frac: int) -> str:
    return "." + f"{frac:06d}".rstrip("0") if frac else ""


def _format_micros(micros: int) -> str:
    negative, h, m, s, frac = _split(micros)
    out = "PT"
    if h:
        out += f"{h}H"
    if m:
        out += f"{m}M"
    if s or frac:
        out += f"{s}{_fraction_text(frac)}S"
    if out == "PT":
        return "PT0S"
    return "-" + out if negative else out


def canonical_duration(text: str) -> str | None:
    """The canonical form of an accepted ISO-8601 duration, or ``None`` when *text* is not one
    (a duration past a ``timedelta``'s range included)."""
    micros = _micros_of_literal(text)
    return None if micros is None or not _in_range(micros) else _format_micros(micros)


def _not_fixed_length(shown: str) -> ValueError:
    return ValueError(
        f"the interval {shown} has a year or month part, so it is not a fixed-length field.duration"
    )


def parse_postgres_interval(text: str) -> _dt.timedelta:
    """The default-style text of a Postgres interval as a ``timedelta``. An interval with a year
    or month part, and text that is not an interval, is a ``ValueError``."""
    m = _PG_INTERVAL_RE.fullmatch(text) if text else None
    if m is None:
        raise ValueError(f"not a Postgres interval: {text!r}")
    years, months, days, time_sign, h, mi, s, f = m.groups()
    if int(years or 0) != 0 or int(months or 0) != 0:
        raise _not_fixed_length(repr(text))
    time = 0
    if h is not None:
        time = int(h) * _MICROS_PER_HOUR + int(mi) * _MICROS_PER_MINUTE + int(s) * _MICROS_PER_SECOND
        time += _fraction_micros(f)
        if time_sign == "-":
            time = -time
    return _from_micros(int(days or 0) * _MICROS_PER_DAY + time)


def duration_from_driver(value: Any) -> _dt.timedelta:
    """What a driver hands back for a duration column, as a ``timedelta``: a ``timedelta``
    (pg8000 for an interval), the microsecond count a SQLite / MySQL integer column holds, a
    canonical ISO string (a duration inside a JSON value object), the default-style text of an
    interval, or a pg8000 ``PGInterval`` (an interval pg8000 could not make a ``timedelta`` of
    because it has a month part, which is refused)."""
    if isinstance(value, _dt.timedelta):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return from_stored_micros(value)
    if isinstance(value, str):
        micros = _micros_of_literal(value)
        return _from_micros(micros) if micros is not None else parse_postgres_interval(value)
    to_timedelta = getattr(value, "to_timedelta", None)
    if callable(to_timedelta):  # pg8000's PGInterval
        if getattr(value, "millennia", None) or getattr(value, "centuries", None) or getattr(
            value, "decades", None
        ) or getattr(value, "years", None) or getattr(value, "months", None):
            raise _not_fixed_length(str(value))
        result = to_timedelta()
        if isinstance(result, _dt.timedelta):
            return result
    raise ValueError(f"not a field.duration value: {value!r}")


def parse_duration_input(value: Any) -> _dt.timedelta:
    """A caller's value for a duration field: an accepted ISO-8601 string, or a ``timedelta``
    already in process. A number is refused (it is not a duration, whatever its unit), and so
    is every string outside the accepted form, including the ones Pydantic's own ``timedelta``
    parser would take (``1:30:00``, ``P1Y``)."""
    if isinstance(value, _dt.timedelta):
        return value
    if isinstance(value, str):
        return parse_duration(value)
    raise ValueError(f"{value!r} is not an ISO-8601 duration (such as PT1H30M; no years or months)")
