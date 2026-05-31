"""R6 Plan 2 — runtime uuid coercion (Java-parity: lowercase-on-read).

The PORT — not Postgres — must canonicalize a uuid column to a lowercased ``str``
on read, dialect-independently (mirrors the Java ``parseField`` uuid fix). These
tests feed ``_coerce_for_contract`` directly (no DB) so the assertion proves the
runtime does the lowercasing, never the database.
"""
from __future__ import annotations

import datetime as _datetime
import uuid as _uuid

from metaobjects.runtime.object_manager import (
    _PG_OID_BIGINT,
    _PG_OID_DATE,
    _PG_OID_NUMERIC,
    _PG_OID_TIME,
    _PG_OID_TIMESTAMP,
    _PG_OID_TIMESTAMPTZ,
    _PG_OID_UUID,
    _coerce_for_contract,
)

# An UPPERCASE canonical uuid string — proves the lowering happens in-port.
_UPPER = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890"
_LOWER = _UPPER.lower()


def test_native_uuid_object_lowercased_to_str() -> None:
    # pg8000 surfaces a uuid column as a native uuid.UUID. Construct one from the
    # UPPERCASE text; str(UUID) is canonical lowercase regardless of input case, so
    # the result proves the PORT returns a lowercased str (not a raw uuid.UUID).
    val = _uuid.UUID(_UPPER)
    result = _coerce_for_contract(val, _PG_OID_UUID)
    assert isinstance(result, str)
    assert result == _LOWER


def test_uuid_text_lowercased_when_uuid_oid() -> None:
    # Some drivers surface a uuid column as text. An UPPERCASE uuid-shaped str on the
    # uuid OID is lowered by the PORT — not by Postgres.
    result = _coerce_for_contract(_UPPER, _PG_OID_UUID)
    assert isinstance(result, str)
    assert result == _LOWER


def test_uuid_native_object_lowered_regardless_of_oid() -> None:
    # A native uuid.UUID is unambiguous — coerce it even if the driver reports a
    # non-uuid OID (defensive; the value type alone is decisive).
    result = _coerce_for_contract(_uuid.UUID(_UPPER), oid=0)
    assert result == _LOWER


def test_uuid_none_passthrough() -> None:
    assert _coerce_for_contract(None, _PG_OID_UUID) is None


def test_non_uuid_text_on_uuid_oid_passthrough() -> None:
    # A non-uuid-shaped str on the uuid OID is left verbatim (no false lowering).
    assert _coerce_for_contract("Not-A-UUID", _PG_OID_UUID) == "Not-A-UUID"


def test_plain_string_untouched() -> None:
    # A plain text column (non-uuid OID) is never lowercased.
    assert _coerce_for_contract("MixedCase", oid=25) == "MixedCase"


def test_bigint_and_numeric_still_coerced() -> None:
    # Regression guard: the pre-existing BIGINT/NUMERIC contract is unchanged.
    import decimal

    assert _coerce_for_contract(42, _PG_OID_BIGINT) == "42"
    assert _coerce_for_contract(decimal.Decimal("1.2300"), _PG_OID_NUMERIC) == "1.23"


# --- Temporal wire contract (Phase B Unit 4) --------------------------------
#
# The OID — not the python value type — discriminates TIMESTAMP from TIMESTAMPTZ
# (pg8000 returns datetimes that differ only by tzinfo). These feed
# _coerce_for_contract directly (no DB) so the assertion proves the PORT pins the
# wire form: TIMESTAMPTZ → UTC + "Z", TIMESTAMP → no Z, DATE/TIME → ISO.


def test_timestamptz_non_utc_offset_reads_back_as_utc_z() -> None:
    # A NON-UTC-offset instant must normalize to its UTC equivalent + "Z" —
    # proving normalization, not just formatting. 09:30-05:00 == 14:30Z.
    val = _datetime.datetime(
        2026, 5, 31, 9, 30, 0,
        tzinfo=_datetime.timezone(-_datetime.timedelta(hours=5)),
    )
    assert _coerce_for_contract(val, _PG_OID_TIMESTAMPTZ) == "2026-05-31T14:30:00Z"


def test_timestamptz_utc_instant_keeps_z() -> None:
    val = _datetime.datetime(2026, 5, 31, 14, 30, 0, tzinfo=_datetime.timezone.utc)
    assert _coerce_for_contract(val, _PG_OID_TIMESTAMPTZ) == "2026-05-31T14:30:00Z"


def test_plain_timestamp_naive_has_no_z() -> None:
    # pg8000 returns a naive datetime for plain TIMESTAMP; the wall clock passes
    # through with NO Z (the Z suffix is the TIMESTAMPTZ discriminator).
    val = _datetime.datetime(2026, 5, 31, 14, 30, 0)
    assert _coerce_for_contract(val, _PG_OID_TIMESTAMP) == "2026-05-31T14:30:00"


def test_date_coerced_to_iso_date() -> None:
    assert _coerce_for_contract(_datetime.date(2026, 5, 31), _PG_OID_DATE) == "2026-05-31"


def test_time_coerced_to_whole_second_hms() -> None:
    assert _coerce_for_contract(_datetime.time(14, 30, 0), _PG_OID_TIME) == "14:30:00"


def test_temporal_none_passthrough() -> None:
    assert _coerce_for_contract(None, _PG_OID_TIMESTAMPTZ) is None
