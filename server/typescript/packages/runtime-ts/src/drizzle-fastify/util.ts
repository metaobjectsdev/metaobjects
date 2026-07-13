/**
 * Shared utilities for drizzle-fastify route helpers.
 */

/**
 * Coerce a path-param id to number when numeric, else keep the string key.
 *
 * @deprecated UNSAFE for any context that has a column (or metadata) to inspect:
 * on a TEXT/string primary key a numeric-LOOKING id is silently converted
 * ('0123' → 123), and SQLite's comparison affinity then matches the OTHER row
 * ('123') — a wrong-row read/update/DELETE. Use `coerceIdForColumn` with the
 * PK column ref instead. This remains only as the fallback for raw-SQL views
 * with no declared columns (via `coerceIdForColumn`/`rawIdLiteral`).
 */
export function parseId(raw: string): number | string {
  const n = Number(raw);
  return Number.isFinite(n) && raw.trim() !== "" ? n : raw;
}

/**
 * Coerce a path-param id to what the PK column actually expects.
 *
 * A Drizzle column carries its own JS `dataType`, so a mount can read the PK's type
 * straight off the view rather than assuming it is numeric. Forcing every id through
 * `Number()` makes a uuid/text PK unfindable: `Number(<uuid>)` is NaN, and `eq(col, NaN)`
 * matches no row (libsql throws outright) — so a row that is plainly present in the list
 * response 404s on its own detail route.
 *
 * Returns `undefined` only when the id is malformed FOR A NUMERIC column — the one case
 * in which a bad id is actually knowable — so the caller can answer 400. With no column
 * to inspect (a raw-SQL view with no declared columns) it falls back to `parseId`.
 */
export function coerceIdForColumn(colRef: unknown, raw: string): number | string | undefined {
  const dataType = (colRef as { dataType?: string } | undefined)?.dataType;
  if (dataType === "number") {
    const n = Number(raw);
    return Number.isFinite(n) && raw.trim() !== "" ? n : undefined;
  }
  if (dataType !== undefined) return raw; // string / uuid / bigint / … — compare as given
  return parseId(raw);
}

/**
 * SQL literal for an id on a raw-SQL view (no declared columns to inspect). Numeric ids
 * stay unquoted; anything else is emitted as a quote-escaped string literal, so a uuid
 * key is matched rather than coerced to NaN. SQLite applies column affinity on comparison,
 * so both forms land on the right column type.
 */
export function rawIdLiteral(raw: string): string {
  const v = parseId(raw);
  return typeof v === "number" ? String(v) : `'${raw.replace(/'/g, "''")}'`;
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
