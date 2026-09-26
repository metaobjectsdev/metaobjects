/**
 * List-query parameter checks shared by every mount — the Drizzle mounts (Fastify and
 * Hono) and the ObjectManager Fastify mount. Deliberately free of drizzle-orm (an
 * OPTIONAL peer): the ObjectManager mount must not pull it in.
 */

export class FilterParseError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "FilterParseError";
  }
}

/** The page-size ceiling of a raw-SQL (column-less `.existing()`) view list, which has
 *  no allowlist to page through and returns at most this many rows. */
export const RAW_VIEW_MAX_LIMIT = 1000;

/** The `expected` member of a `pagination.invalid_value` answer with no upper bound. */
export const PAGINATION_EXPECTED = "a non-negative integer (0 or more)";

/**
 * Read `?limit=` / `?offset=` as a non-negative integer, or refuse it. Before, a value
 * that was not a finite number (`?limit=abc`) was dropped — every row came back — and a
 * negative or fractional one reached SQL. `max` is the ceiling a mount clamps to, when it
 * has one: a bound above it is refused rather than silently lowered. TS-only (no corpus
 * scenario sends a malformed page bound): see docs/features/api-contract.md, "TS-only
 * error responses".
 */
export function parsePageBound(
  query: Record<string, unknown>,
  param: "limit" | "offset",
  max?: number,
): number | undefined {
  const raw = query[param];
  if (raw === undefined) return undefined;
  const s = typeof raw === "string" ? raw : String(raw);
  const n = /^\d+$/.test(s) ? Number(s) : Number.NaN;
  if (!Number.isSafeInteger(n) || (max !== undefined && n > max)) {
    const expected = max === undefined ? PAGINATION_EXPECTED : `an integer from 0 to ${max}`;
    throw new FilterParseError(
      "pagination.invalid_value",
      `?${param}= must be ${expected}, got "${s}".`,
      { param, value: s, expected },
    );
  }
  return n;
}

/** The `expected` member of an `invalid_sort` answer — the one spelling `?sort` takes. */
export const SORT_EXPECTED = "sort=<field>:asc|desc";
