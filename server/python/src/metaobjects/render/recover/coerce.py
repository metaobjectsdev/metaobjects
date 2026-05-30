"""Stage 7: canonicalize a raw scalar string per its FieldSpec.

Returns the ``MALFORMED`` sentinel when the value is present but uncoercible.

Cross-port number rules (parity with C#/TS, an accepted divergence from Java):

- Non-finite (NaN / ±Infinity) → MALFORMED.
- Radix-prefixed strings (``0x..`` / ``0b..`` / ``0o..``) are REJECTED. Python's
  ``int(s, 0)`` would accept them but Java's ``Long.parseLong`` / C#'s
  ``long.TryParse`` reject them — so the C# and TS ports added this guard; we match.
- We do NOT replicate Java's ``Double.parseDouble`` suffix tolerance
  (``"42d"`` / hex-float) — documented accepted divergence (same as C#/TS).
"""
from __future__ import annotations

import math
import re
from typing import Final

from metaobjects.render.recover.types import (
    Coercion,
    FieldKind,
    FieldSpec,
    RecoverOptions,
    RecoveryReport,
    Tolerance,
)

# Sentinel: the value was present but could not be coerced to the declared kind/vocabulary.
MALFORMED: Final = object()

# A canonical ASCII numeric literal (int / decimal / scientific). Python's int()/float()
# are far more permissive than Java/C# numeric parsing — they accept underscore digit
# grouping ("1_000", PEP 515), Unicode digits ("１２３"), and radix prefixes ("0x10"). Gating
# on this ASCII-only pattern rejects all of those → MALFORMED, matching the strict cross-port
# behavior (C#'s TryParse). `[0-9]` (not `\d`) keeps it ASCII-only.
_ASCII_NUMERIC = re.compile(r"^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$")


def value(
    raw: str | None,
    spec: FieldSpec,
    opts: RecoverOptions,
    field_path: str,
    report: RecoveryReport,
) -> object:
    """Canonicalize ``raw`` to the native type described by ``spec``, or MALFORMED."""
    if raw is None:
        return MALFORMED

    # OnField hook takes priority.
    if opts.on_field is not None:
        hooked = opts.on_field(field_path, raw, spec)
        if hooked is not None:
            report.add_coercion(Coercion(field_path, raw, str(hooked), "onField"))
            return hooked

    # Per-field runtime normalizer (bounded 20% surface). Keyed by path, then simple name.
    norm = opts.normalizers.get(field_path)
    if norm is None:
        norm = opts.normalizers.get(spec.name)
    if norm is not None:
        normalized = norm(raw)
        if normalized is not None:
            report.add_coercion(Coercion(field_path, raw, str(normalized), "normalizer"))
            return normalized

    ci = opts.tolerance != Tolerance.STRICT
    match spec.kind:
        case FieldKind.ENUM:
            return _coerce_enum(raw, spec, opts, field_path, report, ci)
        case FieldKind.INT | FieldKind.LONG:
            return _coerce_int(raw, spec, field_path, report)
        case FieldKind.DOUBLE:
            return _coerce_double(raw, spec, field_path, report)
        case FieldKind.BOOLEAN:
            return _coerce_bool(raw, ci)
        case _:
            return raw


def _coerce_enum(
    raw: str,
    spec: FieldSpec,
    opts: RecoverOptions,
    path: str,
    report: RecoveryReport,
    ci: bool,
) -> object:
    if spec.enum_values is not None:
        for v in spec.enum_values:
            if v == raw:
                return v
            if ci and v.lower() == raw.lower():
                report.add_coercion(Coercion(path, raw, v, "case"))
                return v
    schema_target = None if spec.enum_alias is None else spec.enum_alias.get(raw)
    runtime_target = opts.aliases.get(raw)
    if runtime_target is not None:
        kind = (
            "runtime-alias-override"
            if schema_target is not None and schema_target != runtime_target
            else "alias"
        )
        report.add_coercion(Coercion(path, raw, runtime_target, kind))
        return runtime_target
    if schema_target is not None:
        report.add_coercion(Coercion(path, raw, schema_target, "alias"))
        return schema_target
    return MALFORMED


def _coerce_int(raw: str, spec: FieldSpec, path: str, report: RecoveryReport) -> object:
    trimmed = raw.strip()
    if not _ASCII_NUMERIC.match(trimmed):
        return MALFORMED
    # Integer parse first (matches Java Long.parseLong / C# long.TryParse), then a
    # float fallback (matches Java's Double.parseDouble fallback).
    try:
        return _clamp(float(int(trimmed)), spec, path, report, as_long=True)
    except ValueError:
        pass
    try:
        d = float(trimmed)
    except ValueError:
        return MALFORMED
    return _clamp(d, spec, path, report, as_long=True)


def _coerce_double(raw: str, spec: FieldSpec, path: str, report: RecoveryReport) -> object:
    trimmed = raw.strip()
    if not _ASCII_NUMERIC.match(trimmed):
        return MALFORMED
    try:
        d = float(trimmed)
    except ValueError:
        return MALFORMED
    return _clamp(d, spec, path, report, as_long=False)


def _clamp(
    n: float, spec: FieldSpec, path: str, report: RecoveryReport, as_long: bool
) -> object:
    # Non-finite (NaN, ±Infinity) → MALFORMED (cross-port classification parity).
    if not math.isfinite(n):
        return MALFORMED
    c = n
    if spec.min is not None and c < spec.min:
        c = spec.min
    if spec.max is not None and c > spec.max:
        c = spec.max
    if c != n:
        report.add_coercion(Coercion(path, _num_str(n), _num_str(c), "clamp"))
    # Truncate toward zero for integer kinds (math.trunc / int()).
    return math.trunc(c) if as_long else c


def _num_str(n: float) -> str:
    # Render integral floats without a trailing ".0" to read like Java/C# longs in notes.
    if n == math.trunc(n) and math.isfinite(n):
        return str(int(n))
    return str(n)


def _coerce_bool(raw: str, ci: bool) -> object:
    t = raw.strip().lower() if ci else raw.strip()
    if t in ("true", "yes", "1"):
        return True
    if t in ("false", "no", "0"):
        return False
    return MALFORMED
