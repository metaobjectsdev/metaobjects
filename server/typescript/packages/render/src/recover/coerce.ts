// Stage 7: canonicalize a raw scalar string per its FieldSpec. Returns the MALFORMED
// sentinel when present-but-uncoercible. Mirrors Java Coerce.
//
// Tier-2 divergence (documented, parity with the C# port's KNOWN_GAPS): JS has one
// number type. INT/LONG both truncate toward zero via Math.trunc and return `number`.
// Coercion uses Number(...) + Number.isFinite, NOT Java's Double.parseDouble — so JS
// does NOT accept Java's numeric suffixes ("42d"/"42f") or hex-float literals. The
// load-bearing contract (finite-only acceptance; NaN/±Infinity → MALFORMED; numeric
// classification) is identical across ports.

import { FieldKind, Tolerance } from "./types.js";
import type { FieldSpec, RecoverOptions, RecoveryReport } from "./types.js";

/** Sentinel: the value was present but could not be coerced to the declared kind/vocabulary. */
export const MALFORMED: unique symbol = Symbol("recover.coerce.MALFORMED");

export function coerceValue(
  raw: string | null,
  spec: FieldSpec,
  opts: RecoverOptions,
  fieldPath: string,
  report: RecoveryReport,
): unknown | typeof MALFORMED {
  if (raw == null) return MALFORMED;

  if (opts.onField != null) {
    const hooked = opts.onField(fieldPath, raw, spec);
    if (hooked != null) {
      report.addCoercion({ fieldPath, from: raw, to: stringify(hooked), kind: "onField" });
      return hooked;
    }
  }

  // Per-field runtime normalizer (bounded 20% surface). Keyed by field path, then simple name.
  const norm = opts.normalizers[fieldPath] ?? opts.normalizers[spec.name];
  if (norm != null) {
    const normalized = norm(raw);
    if (normalized != null) {
      report.addCoercion({ fieldPath, from: raw, to: stringify(normalized), kind: "normalizer" });
      return normalized;
    }
  }

  const ci = opts.tolerance !== Tolerance.STRICT;
  switch (spec.kind) {
    case FieldKind.ENUM:
      return coerceEnum(raw, spec, opts, fieldPath, report, ci);
    case FieldKind.INT:
    case FieldKind.LONG:
      return coerceInt(raw, spec, fieldPath, report);
    case FieldKind.DOUBLE:
      return coerceDouble(raw, spec, fieldPath, report);
    case FieldKind.BOOLEAN:
      return coerceBool(raw, ci);
    default:
      return raw;
  }
}

function coerceEnum(
  raw: string,
  spec: FieldSpec,
  opts: RecoverOptions,
  path: string,
  report: RecoveryReport,
  ci: boolean,
): unknown | typeof MALFORMED {
  if (spec.enumValues != null) {
    for (const v of spec.enumValues) {
      if (v === raw) return v;
      if (ci && v.toLowerCase() === raw.toLowerCase()) {
        report.addCoercion({ fieldPath: path, from: raw, to: v, kind: "case" });
        return v;
      }
    }
  }
  const schemaTarget = spec.enumAlias == null ? undefined : spec.enumAlias[raw];
  const runtimeTarget = opts.aliases[raw];
  if (runtimeTarget != null) {
    const kind = schemaTarget != null && schemaTarget !== runtimeTarget ? "runtime-alias-override" : "alias";
    report.addCoercion({ fieldPath: path, from: raw, to: runtimeTarget, kind });
    return runtimeTarget;
  }
  if (schemaTarget != null) {
    report.addCoercion({ fieldPath: path, from: raw, to: schemaTarget, kind: "alias" });
    return schemaTarget;
  }
  return MALFORMED;
}

function coerceInt(raw: string, spec: FieldSpec, path: string, report: RecoveryReport): unknown | typeof MALFORMED {
  const n = parseFiniteNumber(raw);
  if (n === null) return MALFORMED;
  return clamp(Math.trunc(n), spec, path, report);
}

function coerceDouble(raw: string, spec: FieldSpec, path: string, report: RecoveryReport): unknown | typeof MALFORMED {
  const n = parseFiniteNumber(raw);
  if (n === null) return MALFORMED;
  return clamp(n, spec, path, report);
}

/** Parse a trimmed numeric string; null if empty, non-numeric, or non-finite (NaN/±Infinity). */
function parseFiniteNumber(raw: string): number | null {
  const t = raw.trim();
  if (t.length === 0) return null;
  // Reject JS-only radix-prefixed literals (0x.., 0b.., 0o..) that Number() would
  // accept but Java/C# numeric parsing rejects → MALFORMED. Keeps cross-port parity.
  if (/^[+-]?0[xXbBoO]/.test(t)) return null;
  const n = Number(t); // Number("") === 0, hence the empty guard above
  return Number.isFinite(n) ? n : null;
}

function clamp(n: number, spec: FieldSpec, path: string, report: RecoveryReport): number {
  let c = n;
  if (spec.min != null && c < spec.min) c = spec.min;
  if (spec.max != null && c > spec.max) c = spec.max;
  if (c !== n) report.addCoercion({ fieldPath: path, from: stringify(n), to: stringify(c), kind: "clamp" });
  return c;
}

function coerceBool(raw: string, ci: boolean): boolean | typeof MALFORMED {
  const t = ci ? raw.trim().toLowerCase() : raw.trim();
  switch (t) {
    case "true":
    case "yes":
    case "1":
      return true;
    case "false":
    case "no":
    case "0":
      return false;
    default:
      return MALFORMED;
  }
}

/** Canonical string form (locale-independent), mirroring Java String.valueOf for the corpus. */
function stringify(v: unknown): string {
  return String(v);
}
