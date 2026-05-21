/**
 * Shared utilities for drizzle-fastify route helpers.
 */

// Accepts "1" or boolean true (the qs serialization of withCount: 1 from buildFilterQs).
export function isTruthyFlag(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  return String(v) === "1";
}
