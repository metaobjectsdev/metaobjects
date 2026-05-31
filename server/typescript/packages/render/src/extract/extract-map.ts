// Null-safe coercions from a ExtractionOutcome data map onto typed values. Generated
// extract(...) calls these. Mirrors Java ExtractMap.
//
// Tier-2 divergence: JS has one number type, so asInt/asLong both return `number | null`
// and truncate toward zero via Math.trunc (Java intValue()/longValue() also truncate).
// The numeric helpers gate on actual numbers (mirroring Java `instanceof Number`): a
// non-numeric string or a boolean returns null rather than coercing.

export function asString(d: Record<string, unknown>, k: string): string | null {
  const v = d[k];
  if (v == null) return null;
  return typeof v === "string" ? v : String(v);
}

export function asInt(d: Record<string, unknown>, k: string): number | null {
  const v = d[k];
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

export function asLong(d: Record<string, unknown>, k: string): number | null {
  const v = d[k];
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

export function asDouble(d: Record<string, unknown>, k: string): number | null {
  const v = d[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function asBool(d: Record<string, unknown>, k: string): boolean | null {
  const v = d[k];
  return typeof v === "boolean" ? v : null;
}

export function asStringList(d: Record<string, unknown>, k: string): (string | null)[] | null {
  const v = d[k];
  if (!Array.isArray(v)) return null;
  return v.map((e) => (e == null ? null : typeof e === "string" ? e : String(e)));
}
