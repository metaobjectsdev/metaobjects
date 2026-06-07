/**
 * Shared utilities for drizzle-fastify route helpers.
 */

/** Coerce a path-param id to number when numeric, else keep the string key. */
export function parseId(raw: string): number | string {
  const n = Number(raw);
  return Number.isFinite(n) && raw.trim() !== "" ? n : raw;
}

// Accepts "1" or boolean true (the qs serialization of withCount: 1 from buildFilterQs).
export function isTruthyFlag(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  return String(v) === "1";
}

// Cross-port REST contract error envelope (FR-008/009). The internal
// FilterParseError carries fine-grained dotted codes (filter.unknown_field,
// sort.unknown_field, ...); the HTTP wire contract that every port's generated
// API must emit uses the coarser invalid_filter_field / invalid_filter_op /
// invalid_filter_value / invalid_sort envelope. Map at the HTTP boundary so the
// internal codes stay stable while the response conforms cross-port.
export function contractErrorCode(internal: string): string {
  switch (internal) {
    case "filter.unknown_field":
      return "invalid_filter_field";
    case "filter.unsupported_op":
      return "invalid_filter_op";
    case "filter.invalid_value":
      return "invalid_filter_value";
    case "sort.unknown_field":
    case "sort.invalid_order":
      return "invalid_sort";
    default:
      // Implementation-specific guards (nesting depth, in-list size, leading
      // wildcard) are not part of the cross-port contract surface; pass through.
      return internal;
  }
}
