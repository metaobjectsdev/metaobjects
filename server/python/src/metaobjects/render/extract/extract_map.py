"""Null-safe coercions from a ExtractionOutcome data map onto typed values.

Generated ``extract(...)`` code calls these helpers. Python has a single ``int``
type, so ``as_int`` and ``as_long`` are intentionally identical (both
``Optional[int]``, truncating toward zero). ``bool`` is excluded from the numeric
helpers (it is an ``int`` subclass in Python, but a boolean is never a number here).
"""
from __future__ import annotations

import math
from collections.abc import Mapping


def as_string(d: Mapping[str, object], k: str) -> str | None:
    if k not in d:
        return None
    v = d[k]
    if v is None:
        return None
    return v if isinstance(v, str) else str(v)


def as_int(d: Mapping[str, object], k: str) -> int | None:
    return _as_int(d, k)


def as_long(d: Mapping[str, object], k: str) -> int | None:
    # Python has one int type; as_int and as_long are the same (truncate toward zero).
    return _as_int(d, k)


def _as_int(d: Mapping[str, object], k: str) -> int | None:
    v = d.get(k)
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return math.trunc(v)
    return None


def as_double(d: Mapping[str, object], k: str) -> float | None:
    v = d.get(k)
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    return None


def as_bool(d: Mapping[str, object], k: str) -> bool | None:
    v = d.get(k)
    return v if isinstance(v, bool) else None


def as_string_list(d: Mapping[str, object], k: str) -> list[str | None] | None:
    v = d.get(k)
    if not isinstance(v, list):
        return None
    return [None if e is None else (e if isinstance(e, str) else str(e)) for e in v]
