"""Boundary canonicalization (ADR-0019): the runtime returns native types; the
serialization seam (``tests/integration/normalization.normalize_value``) maps each
native Python value to its cross-port wire form.

These were originally tests of ``ObjectManager._coerce_for_contract`` (in-runtime
canonicalization). Per ADR-0019 the runtime no longer canonicalizes — ``find_*``
return native pg8000 values (``int`` / ``Decimal`` / ``datetime`` / ``date`` /
``time`` / ``uuid.UUID`` / ``dict`` / ``list``). The wire-form mapping moved to the
runner's ``normalize_value``, so the same assertions now target that boundary. No
database is required.
"""
from __future__ import annotations

import datetime as _datetime
import decimal
import uuid as _uuid

from tests.integration.normalization import normalize_value

# Stable Postgres type OIDs (see pg_type.dat). The OID is the int4-vs-int8 wire
# discriminator the native Python value cannot carry — ObjectManager surfaces it
# via ``last_column_oids`` so the boundary applies the BIGINT→string rule.
_OID_BIGINT = 20
_OID_NUMERIC = 1700
_OID_UUID = 2950
_OID_TIMESTAMP = 1114
_OID_TIMESTAMPTZ = 1184
_OID_DATE = 1082
_OID_TIME = 1083

# An UPPERCASE canonical uuid string — proves the lowering happens at the boundary.
_UPPER = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890"
_LOWER = _UPPER.lower()


def test_native_uuid_object_lowercased_to_str() -> None:
    # pg8000 surfaces a uuid column as a native uuid.UUID; the boundary lowercases
    # to a str regardless of input case (str(UUID) is canonical lowercase).
    result = normalize_value(_uuid.UUID(_UPPER), _OID_UUID)
    assert isinstance(result, str)
    assert result == _LOWER


def test_uuid_text_lowercased_when_uuid_shaped() -> None:
    # Some drivers surface a uuid column as text. An UPPERCASE uuid-shaped str is
    # lowered by the boundary — not by Postgres.
    result = normalize_value(_UPPER)
    assert isinstance(result, str)
    assert result == _LOWER


def test_uuid_native_object_lowered_regardless_of_oid() -> None:
    # A native uuid.UUID is unambiguous — lowered by value type alone.
    assert normalize_value(_uuid.UUID(_UPPER)) == _LOWER


def test_uuid_none_passthrough() -> None:
    assert normalize_value(None, _OID_UUID) is None


def test_non_uuid_text_passthrough() -> None:
    # A non-uuid-shaped str is left verbatim (no false lowering).
    assert normalize_value("Not-A-UUID") == "Not-A-UUID"


def test_plain_string_untouched() -> None:
    assert normalize_value("MixedCase") == "MixedCase"


def test_bigint_and_numeric_canonicalized() -> None:
    # BIGINT → string by OID; NUMERIC (native Decimal) → no-trailing-zero string.
    assert normalize_value(42, _OID_BIGINT) == "42"
    assert normalize_value(decimal.Decimal("1.2300"), _OID_NUMERIC) == "1.23"


def test_integer_oid_stays_number() -> None:
    # INTEGER/SMALLINT (any non-int8 OID) stays a JSON number.
    assert normalize_value(30, 23) == 30


def test_bool_before_int() -> None:
    # bool is an int subclass — must not be stringified even on a BIGINT OID.
    assert normalize_value(True, _OID_BIGINT) is True


# --- Temporal wire contract -------------------------------------------------
#
# pg8000 returns datetimes that differ only by tzinfo; the boundary discriminates
# TIMESTAMP from TIMESTAMPTZ by tzinfo (ADR-0019), not by OID: tz-aware → UTC +
# "Z", naive → no Z, DATE/TIME → their forms (millisecond, omit-when-zero).


def test_timestamptz_non_utc_offset_reads_back_as_utc_z() -> None:
    val = _datetime.datetime(
        2026, 5, 31, 9, 30, 0,
        tzinfo=_datetime.timezone(-_datetime.timedelta(hours=5)),
    )
    assert normalize_value(val, _OID_TIMESTAMPTZ) == "2026-05-31T14:30:00Z"


def test_timestamptz_utc_instant_keeps_z() -> None:
    val = _datetime.datetime(2026, 5, 31, 14, 30, 0, tzinfo=_datetime.timezone.utc)
    assert normalize_value(val, _OID_TIMESTAMPTZ) == "2026-05-31T14:30:00Z"


def test_plain_timestamp_naive_has_no_z() -> None:
    val = _datetime.datetime(2026, 5, 31, 14, 30, 0)
    assert normalize_value(val, _OID_TIMESTAMP) == "2026-05-31T14:30:00"


def test_date_to_iso_date() -> None:
    assert normalize_value(_datetime.date(2026, 5, 31), _OID_DATE) == "2026-05-31"


def test_time_whole_second_hms() -> None:
    assert normalize_value(_datetime.time(14, 30, 0), _OID_TIME) == "14:30:00"


def test_time_truncates_to_milliseconds() -> None:
    # .123456 → .123 (truncate to millisecond resolution, not round/passthrough).
    assert normalize_value(_datetime.time(14, 30, 0, 123456), _OID_TIME) == "14:30:00.123"


def test_temporal_none_passthrough() -> None:
    assert normalize_value(None, _OID_TIMESTAMPTZ) is None
