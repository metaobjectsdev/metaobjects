// Result normalization — see fixtures/persistence-conformance/normalization.md.
//
// Every per-port runner must produce identical normalized output for the same
// DB row so scenarios are byte-comparable. Pin the type-coercion rules here so
// they never drift from the contract.

export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = normalizeValue(v);
  return out;
}

// NUMERIC/DECIMAL canonical form: trim trailing zeros from the fractional part,
// drop the decimal point itself if the value is integer-valued. Matches the
// C# CanonicalDecimal helper. Returns the input unchanged if it is not a
// decimal-looking string.
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  // INTEGER/SMALLINT come back as integer-valued JS numbers → keep as JSON number.
  // REAL/DOUBLE come back as non-integer JS numbers → stringify (plain decimal, strip zeros).
  // (The runner sees an already-mapped row with no column-type metadata; fixtures pin
  // float/double values to be non-integer so this value-route is exact — see normalization.md.)
  if (typeof v === "number") return Number.isInteger(v) ? v : canonicalFloat(v);
  // node-postgres returns BIGINT as string by default — leave as string (contract).
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") {
    // node-postgres returns NUMERIC/DECIMAL as a string ("100.00") — canonicalize.
    if (DECIMAL_RE.test(v) && v.includes(".")) return canonicalDecimal(v);
    // node-postgres returns UUID as a string; the contract pins lowercase form.
    if (UUID_RE.test(v)) return v.toLowerCase();
    return v;
  }

  // Date — distinguish TIMESTAMP (no TZ) vs TIMESTAMPTZ (Z). node-pg returns
  // both as JS Date; we can't tell them apart without column-type metadata.
  // Pragmatic v1: format using UTC getters with no Z (matches the C# DateTime
  // branch for TIMESTAMP). Scenarios that need TIMESTAMPTZ comparison must be
  // authored against the same shape and either side's driver should expose
  // them via DateTimeOffset / explicit string for the Z to round-trip.
  if (v instanceof Date) return formatDateUtcNoZ(v);

  // Buffer / Uint8Array → base64.
  if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");

  // JSON-like object (jsonb returns parsed) → recurse with sorted keys.
  if (typeof v === "object") {
    if (Array.isArray(v)) return v.map(normalizeValue);
    const obj = v as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = normalizeValue(obj[k]);
    return sorted;
  }

  return String(v);
}

function canonicalDecimal(s: string): string {
  let out = s.replace(/0+$/, "");
  if (out.endsWith(".")) out = out.slice(0, -1);
  return out;
}

function canonicalFloat(n: number): string {
  // In-band dyadic values (per normalization.md) render plain + shortest via String().
  let out = String(n);
  if (out.includes(".")) {
    out = out.replace(/0+$/, "");
    if (out.endsWith(".")) out = out.slice(0, -1);
  }
  return out;
}

// Format a Date as YYYY-MM-DDTHH:MM:SS[.fff] using UTC getters so the output
// is independent of the runner's host timezone. Trailing zero subseconds are
// trimmed; the decimal point goes too if the subseconds were entirely zero.
// Matches the C# DateTime branch (TIMESTAMP without TZ).
function formatDateUtcNoZ(d: Date): string {
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  const ms = d.getUTCMilliseconds();
  let s =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  if (ms !== 0) s += `.${pad(ms, 3)}`;
  return s;
}

/**
 * Stable JSON: sort object keys recursively before serializing so two semantically
 * equal results compare byte-equal regardless of key insertion order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sortKeys);
  const obj = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
  return out;
}
