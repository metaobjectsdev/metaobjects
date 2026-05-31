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

from metaobjects.render.recover.normalize import NONE as _NORMALIZE_NONE
from metaobjects.render.recover.normalize import normalize_enum
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


def scalar_coerce(raw: str | None, spec: FieldSpec) -> object:
    """Phase B (generalized ``@default``): coerce a non-enum default string to a
    field's scalar kind, with NO side effects (no normalizer/on_field hooks, no
    clamp logging) — the value originates from metadata, not the model response.

    Returns the coerced value or the ``MALFORMED`` sentinel. INT/LONG accept an
    integer or a truncatable finite number; DOUBLE accepts any finite number;
    BOOLEAN accepts ``true|false|yes|no|1|0``; STRING (and any other kind) passes
    through verbatim. Mirrors the parse semantics of :func:`value` without its
    range-clamp / report machinery (Java ``Coerce.scalar``).
    """
    if raw is None:
        return MALFORMED
    match spec.kind:
        case FieldKind.INT | FieldKind.LONG:
            trimmed = raw.strip()
            if not _ASCII_NUMERIC.match(trimmed):
                return MALFORMED
            try:
                return int(trimmed)
            except ValueError:
                pass
            try:
                d = float(trimmed)
            except ValueError:
                return MALFORMED
            return math.trunc(d) if math.isfinite(d) else MALFORMED
        case FieldKind.DOUBLE:
            trimmed = raw.strip()
            if not _ASCII_NUMERIC.match(trimmed):
                return MALFORMED
            try:
                d = float(trimmed)
            except ValueError:
                return MALFORMED
            return d if math.isfinite(d) else MALFORMED
        case FieldKind.BOOLEAN:
            t = raw.strip().lower()
            if t in ("true", "yes", "1"):
                return True
            if t in ("false", "no", "0"):
                return False
            return MALFORMED
        case _:
            return raw  # STRING / ENUM / OBJECT — verbatim


def _coerce_enum(
    raw: str,
    spec: FieldSpec,
    opts: RecoverOptions,
    path: str,
    report: RecoveryReport,
    ci: bool,
) -> object:
    """FR-011 enum coercion pipeline: exact → normalize → ``@enumAlias`` →
    (reserved fuzzy) → ``@coerceDefault`` → MALFORMED.

    Resolution mode is ``spec.normalize`` (default ``"strip"``); under STRICT
    tolerance (``ci`` is False) normalization is forced to ``"none"`` (exact-only),
    preserving the case-sensitive STRICT contract. The FR-010 case-insensitive
    default is now mode ``"strip"``. Mirrors the TS/C#/Java ``coerceEnum``.
    """
    mode = spec.normalize if ci else _NORMALIZE_NONE

    # 1. exact match.
    if spec.enum_values is not None:
        for v in spec.enum_values:
            if v == raw:
                return v

    # 2. normalized match (skipped when mode == none).
    if mode != _NORMALIZE_NONE and spec.enum_values is not None:
        norm_raw = normalize_enum(raw, mode)
        for v in spec.enum_values:
            if normalize_enum(v, mode) == norm_raw:
                report.add_coercion(Coercion(path, raw, v, "normalize"))
                return v

    # 3. @enumAlias — runtime aliases win over schema; alias keys matched under the mode.
    runtime_target = _lookup_alias_in(raw, opts.aliases, mode)
    if runtime_target is not None:
        schema_target = _lookup_alias_in(raw, spec.enum_alias, mode)
        kind = (
            "runtime-alias-override"
            if schema_target is not None and schema_target != runtime_target
            else "alias"
        )
        report.add_coercion(Coercion(path, raw, runtime_target, kind))
        return runtime_target
    schema_target = _lookup_alias_in(raw, spec.enum_alias, mode)
    if schema_target is not None:
        report.add_coercion(Coercion(path, raw, schema_target, "alias"))
        return schema_target

    # 4. reserved fuzzy slot — NOT implemented (FR-011 spec "Out of scope").

    # 5. @coerceDefault — present-but-uncoercible fallback to a valid member → DEFAULTED.
    if (
        spec.coerce_default is not None
        and spec.enum_values is not None
        and spec.coerce_default in spec.enum_values
    ):
        report.add_coercion(Coercion(path, raw, spec.coerce_default, "coerceDefault"))
        return spec.coerce_default

    # 6. MALFORMED.
    return MALFORMED


def _lookup_alias_in(raw: str, aliases: dict[str, str] | None, mode: str) -> str | None:
    """Find ``raw`` in an alias map, matching keys exactly first then under ``mode``
    normalization. Returns the target member, or ``None`` when no key matches."""
    if not aliases:
        return None
    exact = aliases.get(raw)
    if exact is not None:
        return exact
    if mode == _NORMALIZE_NONE:
        return None
    norm_raw = normalize_enum(raw, mode)
    for key, target in aliases.items():
        if normalize_enum(key, mode) == norm_raw:
            return target
    return None


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
