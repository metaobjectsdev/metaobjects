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

/** The most rows a report list answers, whether or not the caller sends a `limit`. A report
 *  with no `limit` returns every row up to this cap and is refused above it (never
 *  truncated); the same default in all five ports. */
export const REPORT_MAX_ROWS = 10_000;

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

/** The page size of a list route (`api.pagination` in `.metaobjects/config.json`). */
export interface PageSize {
  /** The rows a list with no `limit` returns. */
  readonly defaultLimit: number;
  /** The largest `limit` a list accepts; a larger one is refused, never lowered. */
  readonly maxLimit: number;
}

/** The error code of a `limit` above the page-size maximum. */
export const ERROR_CODE_LIMIT_TOO_LARGE = "limit_too_large";

/**
 * The `limit` a list route applies: the caller's, else the default page size, and a caller's
 * above the maximum is refused with `400 { "error": "limit_too_large", "maxLimit": N }`. Without
 * a page size the caller's `limit` (or none) passes through unchanged, as before.
 */
export function pageLimit(limit: number | undefined, pageSize: PageSize | undefined): number | undefined {
  if (pageSize === undefined) return limit;
  if (limit === undefined) return pageSize.defaultLimit;
  if (limit > pageSize.maxLimit) {
    throw new FilterParseError(
      ERROR_CODE_LIMIT_TOO_LARGE,
      `?limit= must be at most ${pageSize.maxLimit}, got ${limit}.`,
      { maxLimit: pageSize.maxLimit },
    );
  }
  return limit;
}

/** The `expected` member of an `invalid_sort` answer — the one spelling `?sort` takes. */
export const SORT_EXPECTED = "sort=<field>:asc|desc";

/** The page a report list reads: `limit` is how many rows to FETCH, which is one past the
 *  cap when the caller sent none, so the caller can tell exactly the cap apart from more than it. */
export interface ReportPage {
  readonly limit: number;
  readonly offset: number;
  /** True when the caller sent no `limit`, so more than `maxRows` rows means refuse. */
  readonly unbounded: boolean;
}

/** A report answered more rows than `maxRows` allows. The wire answer is
 *  `400 { "error": "report_too_large", "maxRows": N }`. */
export class ReportTooLargeError extends Error {
  constructor(public readonly maxRows: number) {
    super(`A report answers at most ${maxRows} rows; narrow it with a filter or page it with ?limit=.`);
    this.name = "ReportTooLargeError";
  }
}

/**
 * Read a report list's `?limit=` / `?offset=`. A limit is an integer of at least 1 (a
 * report with `limit=0` is a bad bound, not an empty answer) and an offset is a
 * non-negative integer; anything else is `pagination.invalid_value`. A limit above
 * `maxRows` throws {@link ReportTooLargeError}.
 */
export function parseReportPage(query: Record<string, unknown>, maxRows: number): ReportPage {
  const badLimit = (value: string) =>
    new FilterParseError(
      "pagination.invalid_value",
      `?limit= must be an integer from 1 to ${maxRows}, got "${value}".`,
      { param: "limit", value, expected: `an integer from 1 to ${maxRows}` },
    );
  let limit: number | undefined;
  try {
    limit = parsePageBound(query, "limit");
  } catch (e) {
    if (e instanceof FilterParseError) throw badLimit(String(query.limit));
    throw e;
  }
  if (limit === 0) throw badLimit("0");
  if (limit !== undefined && limit > maxRows) throw new ReportTooLargeError(maxRows);
  const offset = parsePageBound(query, "offset") ?? 0;
  return { limit: limit ?? maxRows + 1, offset, unbounded: limit === undefined };
}
