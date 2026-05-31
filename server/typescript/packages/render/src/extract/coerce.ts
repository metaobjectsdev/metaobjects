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
import type { FieldSpec, ExtractOptions, ExtractionReport } from "./types.js";
import { normalizeEnum } from "./normalize.js";
import type { NormalizeMode } from "./normalize.js";

/** Sentinel: the value was present but could not be coerced to the declared kind/vocabulary. */
export const MALFORMED: unique symbol = Symbol("extract.coerce.MALFORMED");

export function coerceValue(
  raw: string | null,
  spec: FieldSpec,
  opts: ExtractOptions,
  fieldPath: string,
  report: ExtractionReport,
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

/**
 * Phase B (generalized `@default`): PURE coercion of a metadata-sourced string to the field's
 * scalar kind, with NO side effects (no normalizer/onField hooks, no clamp logging) — the value
 * originates from metadata, not the model response. Returns the coerced value or the MALFORMED
 * sentinel. INT/LONG accept an integer or a truncatable finite number; DOUBLE accepts any finite
 * number; BOOLEAN accepts `true|false|yes|no|1|0`; STRING (and any other kind) passes through
 * verbatim. Mirrors Java `Coerce.scalar` (parse semantics of {@link coerceValue} without its
 * range-clamp / report machinery).
 */
export function scalarCoerce(raw: string | null, spec: FieldSpec): unknown | typeof MALFORMED {
  if (raw == null) return MALFORMED;
  switch (spec.kind) {
    case FieldKind.INT:
    case FieldKind.LONG: {
      const n = parseFiniteNumber(raw);
      return n === null ? MALFORMED : Math.trunc(n);
    }
    case FieldKind.DOUBLE: {
      const n = parseFiniteNumber(raw);
      return n === null ? MALFORMED : n;
    }
    case FieldKind.BOOLEAN:
      return coerceBool(raw, true);
    default:
      return raw; // STRING / ENUM / OBJECT — verbatim
  }
}

/**
 * FR-011 enum coercion pipeline: exact → normalize → @enumAlias → (reserved fuzzy) →
 * @coerceDefault → MALFORMED. Resolution mode is `spec.normalize` (default "strip"); under
 * STRICT tolerance (ci === false) normalization is forced to "none" (exact-only), preserving
 * the case-sensitive STRICT contract. The FR-010 case-insensitive default is now mode "strip".
 */
function coerceEnum(
  raw: string,
  spec: FieldSpec,
  opts: ExtractOptions,
  path: string,
  report: ExtractionReport,
  ci: boolean,
): unknown | typeof MALFORMED {
  const mode: NormalizeMode = ci ? spec.normalize : "none";

  // 1. exact match.
  if (spec.enumValues != null) {
    for (const v of spec.enumValues) if (v === raw) return v;
  }

  // 2. normalized match (skipped when mode === "none").
  if (mode !== "none" && spec.enumValues != null) {
    const normRaw = normalizeEnum(raw, mode);
    for (const v of spec.enumValues) {
      if (normalizeEnum(v, mode) === normRaw) {
        report.addCoercion({ fieldPath: path, from: raw, to: v, kind: "normalize" });
        return v;
      }
    }
  }

  // 3. @enumAlias — runtime aliases win over schema; alias keys normalized by the mode.
  const aliasTarget = lookupAlias(raw, spec, opts, mode);
  if (aliasTarget != null) {
    const schemaTarget = lookupAliasIn(raw, spec.enumAlias ?? {}, mode);
    const kind =
      aliasTarget.fromRuntime && schemaTarget != null && schemaTarget !== aliasTarget.target
        ? "runtime-alias-override"
        : "alias";
    report.addCoercion({ fieldPath: path, from: raw, to: aliasTarget.target, kind });
    return aliasTarget.target;
  }

  // 4. reserved fuzzy slot — NOT implemented (see FR-011 spec "Out of scope").

  // 5. @coerceDefault — present-but-uncoercible fallback to a valid member → DEFAULTED.
  if (spec.coerceDefault != null && spec.enumValues != null && spec.enumValues.includes(spec.coerceDefault)) {
    report.addCoercion({ fieldPath: path, from: raw, to: spec.coerceDefault, kind: "coerceDefault" });
    return spec.coerceDefault;
  }

  // 6. MALFORMED.
  return MALFORMED;
}

/**
 * Resolve `raw` against the merged alias maps (runtime wins), comparing keys under `mode`.
 * Returns the target member + whether the winning hit came from the runtime map.
 */
function lookupAlias(
  raw: string,
  spec: FieldSpec,
  opts: ExtractOptions,
  mode: NormalizeMode,
): { target: string; fromRuntime: boolean } | null {
  const runtime = lookupAliasIn(raw, opts.aliases, mode);
  if (runtime != null) return { target: runtime, fromRuntime: true };
  const schema = lookupAliasIn(raw, spec.enumAlias ?? {}, mode);
  if (schema != null) return { target: schema, fromRuntime: false };
  return null;
}

/** Find `raw` in an alias map, matching keys exactly first then under `mode` normalization. */
function lookupAliasIn(raw: string, aliases: Readonly<Record<string, string>>, mode: NormalizeMode): string | null {
  if (Object.prototype.hasOwnProperty.call(aliases, raw)) return aliases[raw]!;
  if (mode === "none") return null;
  const normRaw = normalizeEnum(raw, mode);
  for (const key of Object.keys(aliases)) {
    if (normalizeEnum(key, mode) === normRaw) return aliases[key]!;
  }
  return null;
}

function coerceInt(raw: string, spec: FieldSpec, path: string, report: ExtractionReport): unknown | typeof MALFORMED {
  const n = parseFiniteNumber(raw);
  if (n === null) return MALFORMED;
  return clamp(Math.trunc(n), spec, path, report);
}

function coerceDouble(raw: string, spec: FieldSpec, path: string, report: ExtractionReport): unknown | typeof MALFORMED {
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

function clamp(n: number, spec: FieldSpec, path: string, report: ExtractionReport): number {
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
