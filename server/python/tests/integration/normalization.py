"""Per-type row normalization. Mirrors fixtures/persistence-conformance/normalization.md.

The same row → the same canonical JSON on every port, so `expect` blocks
compare byte-equal after canonical serialization.

This is the **serialization boundary** for the Python port (ADR-0019): the
runtime ``ObjectManager`` returns native pg8000 values (``int`` / ``Decimal`` /
``datetime`` / ``date`` / ``time`` / ``uuid.UUID`` / ``dict`` / ``list``); the
canonicalization to the cross-port wire form lives HERE, keyed by Python native
type — mirroring the other ports' by-native-type runners (Java keys off
``Long`` vs ``Integer`` / ``BigDecimal`` / ``OffsetDateTime``; TS keys off
``typeof`` + Number.isInteger).

The one SQL-type distinction a native Python value cannot carry is int4-vs-int8
(pg8000 returns plain ``int`` for both, and a BIGINT aggregate over an INTEGER
column is indistinguishable by value). The boundary recovers it from the
per-column Postgres OID that ``ObjectManager`` surfaces alongside the query
(``last_column_oids``) — the same SQL-type discriminator the other ports get from
their driver's native typing. A field whose column OID is BIGINT (or any int8
OID) stringifies; an INTEGER/SMALLINT int stays a JSON number.
"""
from __future__ import annotations

import base64
import datetime
import decimal
import json
import re
import uuid
from collections.abc import Mapping
from typing import Any

# Stable Postgres type OIDs (see pg_type.dat) for the int8 family — the BIGINT→
# string wire discriminator. INTEGER (23) / SMALLINT (21) stay JSON numbers.
_PG_OID_INT8 = 20  # BIGINT / BIGSERIAL


def normalize_row(
    row: Mapping[str, Any], column_oids: Mapping[str, int] | None = None
) -> dict[str, Any]:
    """Canonicalize a native-typed row to its wire form.

    *column_oids* (field-name → Postgres type OID) supplies the int4-vs-int8
    discriminator the value alone can't carry; when absent (top-level scalar /
    expected-block normalization) the value-only path applies.
    """
    oids = column_oids or {}
    return {k: normalize_value(v, oids.get(k)) for k, v in row.items()}


def normalize_value(v: Any, column_oid: int | None = None) -> Any:
    if v is None:
        return None
    if isinstance(v, bool):
        # bool is an int subclass — must be tested BEFORE int.
        return v
    if isinstance(v, int):
        # BIGINT → string (the cross-port contract; avoids the JS Number 2^53
        # precision cliff). The OID is the authoritative discriminator: pg8000
        # returns plain int for both INTEGER and BIGINT, so we key off the column
        # OID surfaced by ObjectManager. With no OID (a nested jsonb int, or an
        # `expect` literal), fall back to the value heuristic the TS runner uses
        # (stringify ints outside the int4 range) so cross-port output stays
        # stable without column metadata.
        if column_oid == _PG_OID_INT8:
            return str(v)
        if column_oid is not None:
            return v
        return str(v) if v > 2**31 - 1 or v < -(2**31) else v
    if isinstance(v, float):
        return _canonical_float(v)
    if isinstance(v, decimal.Decimal):
        return _canonical_decimal(v)
    if isinstance(v, uuid.UUID):
        return str(v).lower()
    if isinstance(v, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(v)).decode("ascii")
    if isinstance(v, datetime.datetime):
        # The contract distinguishes TIMESTAMP from TIMESTAMPTZ by tzinfo
        # (ADR-0019): pg8000 surfaces a TIMESTAMPTZ as a tz-aware datetime and a
        # plain TIMESTAMP as naive. tz-aware → UTC instant + "Z"; naive → wall
        # clock with no Z. See fixtures/persistence-conformance/normalization.md.
        if v.tzinfo is not None:
            v = v.astimezone(datetime.timezone.utc).replace(tzinfo=None)
            return v.strftime("%Y-%m-%dT%H:%M:%S") + _ms_suffix(v.microsecond) + "Z"
        return v.strftime("%Y-%m-%dT%H:%M:%S") + _ms_suffix(v.microsecond)
    if isinstance(v, datetime.date):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, datetime.time):
        return v.strftime("%H:%M:%S") + _ms_suffix(v.microsecond)
    if isinstance(v, str):
        if _DECIMAL_RE.match(v) and "." in v:
            return _canonical_decimal(decimal.Decimal(v))
        if _UUID_RE.match(v):
            return v.lower()
        return v
    if isinstance(v, Mapping):
        return {k: normalize_value(val) for k, val in sorted(v.items())}
    if isinstance(v, (list, tuple)):
        return [normalize_value(x) for x in v]
    return str(v)


def canonical_rows_json(
    rows: list[Mapping[str, Any]], column_oids: Mapping[str, int] | None = None
) -> str:
    """Stable JSON: sort object keys, no whitespace, normalize each row first."""
    return json.dumps(
        [normalize_row(r, column_oids) for r in rows],
        sort_keys=True,
        separators=(",", ":"),
    )


def canonical_row_set_json(
    rows: list[Mapping[str, Any]], column_oids: Mapping[str, int] | None = None
) -> str:
    """Order-independent canonical JSON for a row *set* (M:N `relate` results).

    Each row is canonicalized then the per-row JSON strings are sorted, so the
    comparison is independent of result order — order is not part of the M:N
    navigation contract. Mirrors the TS runner's ``canonicalRowSet``.
    """
    each = sorted(
        json.dumps(normalize_row(r, column_oids), sort_keys=True, separators=(",", ":"))
        for r in rows
    )
    return "[" + ",".join(each) + "]"


def canonical_value_json(v: Any) -> str:
    """For top-level get/count/scalar expected vs actual comparison."""
    return json.dumps(normalize_value(v), sort_keys=True, separators=(",", ":"))


_DECIMAL_RE = re.compile(r"^-?\d+(\.\d+)?$")
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _canonical_decimal(d: decimal.Decimal) -> str:
    # Trim trailing zeros from the fractional part, drop the point if integer-valued.
    s = format(d.normalize(), "f")
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s


def _canonical_float(x: float) -> str:
    # In-band dyadic values (per normalization.md) render plain + shortest via repr().
    s = repr(x)
    if "e" in s or "E" in s:
        raise ValueError(
            f"_canonical_float: {x} is outside the plain-decimal band (exponential "
            "notation); REAL/DOUBLE fixture values must be in-band dyadic rationals — "
            "see fixtures/persistence-conformance/normalization.md"
        )
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s


def _ms_suffix(microseconds: int) -> str:
    """Sub-second wire component at millisecond resolution, no trailing zeros, with
    the ``.`` and the entire fractional part OMITTED when zero — the exact analogue
    of the NUMERIC/float trailing-zero rule (normalization.md). ``.120`` → ``.12``;
    ``.123`` → ``.123``; ``.000`` → ``""``."""
    millis = microseconds // 1000
    if millis == 0:
        return ""
    return f".{millis:03d}".rstrip("0")
