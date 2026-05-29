"""Per-type row normalization. Mirrors fixtures/persistence-conformance/normalization.md.

The same row → the same canonical JSON on every port, so `expect` blocks
compare byte-equal after canonical serialization.
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


def normalize_row(row: Mapping[str, Any]) -> dict[str, Any]:
    return {k: normalize_value(v) for k, v in row.items()}


def normalize_value(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, int):
        # BIGINT vs INTEGER is a SQL-side distinction; pg8000 returns ints either way.
        # We can't tell them apart without column metadata, so always stringify large
        # ints (> 2^31) and leave smaller ones as JSON numbers. The corpus pins long
        # PKs as strings, so this gives stable cross-port output without overreach.
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
        # TIMESTAMP no Z; TIMESTAMPTZ → Z (UTC). pg8000 returns tz-aware for TIMESTAMPTZ.
        if v.tzinfo is not None:
            return v.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S") \
                + _ms_suffix(v.microsecond) + "Z"
        return v.strftime("%Y-%m-%dT%H:%M:%S") + _ms_suffix(v.microsecond)
    if isinstance(v, datetime.date):
        return v.isoformat()
    if isinstance(v, datetime.time):
        return v.isoformat()
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


def canonical_rows_json(rows: list[Mapping[str, Any]]) -> str:
    """Stable JSON: sort object keys, no whitespace, normalize each row first."""
    return json.dumps([normalize_row(r) for r in rows], sort_keys=True, separators=(",", ":"))


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
    if microseconds == 0:
        return ""
    return f".{microseconds // 1000:03d}"
