import {
  is, Column, SQL as DrizzleSQL,
  eq, ne, gt, gte, lt, lte, inArray, like, ilike, isNull, not, and, or, asc, desc, sql,
  type SQL, type SQLWrapper,
} from "drizzle-orm";
import type { FilterAllowlist, FilterOp, FilterFieldRule, SortAllowlist } from "./filter-allowlist.js";
import { sortOrderSpec } from "./filter-allowlist.js";
import { FilterParseError, parsePageBound, SORT_EXPECTED } from "./list-params.js";

// Re-exported so existing importers keep one door; the definitions live in the
// drizzle-free list-params module, which the ObjectManager Fastify mount also uses.
export { FilterParseError, parsePageBound, PAGINATION_EXPECTED, RAW_VIEW_MAX_LIMIT, SORT_EXPECTED } from "./list-params.js";
import { ANY_TEMPORAL_EXPECTED, FORMAT_EXPECTED, matchesAnyTemporal, matchesFormat, utcIsoIfZoned } from "./filter-value-format.js";
import { FIELD_SUBTYPE_TIMESTAMP } from "@metaobjectsdev/metadata";

// biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch over user's Drizzle table
type AnyTable = any;

export interface ParseFilterOpts {
  query: Record<string, unknown>;
  table: AnyTable;
  allowlist: FilterAllowlist;
  sortAllowlist: SortAllowlist;
  dialect: "sqlite" | "postgres";
  maxNesting?: number;
  maxInListSize?: number;
}

export interface ParseFilterResult {
  where?: SQL;
  orderBy?: SQLWrapper[];
  limit?: number;
  offset?: number;
  /** Search predicate — OR(like('%term%')) across @filterable string fields. */
  searchWhere?: SQL;
}


const DEFAULT_MAX_NESTING = 5;
const DEFAULT_MAX_IN_LIST = 100;

/** Top-level list-query parameters this parser (or the mount around it) reads. A
 *  filterable field that happens to share one of these names is addressed only through
 *  `filter[<name>]`, so the bare-field check below never claims them. */
const RESERVED_LIST_PARAMS: ReadonlySet<string> = new Set([
  "filter", "sort", "limit", "offset", "search", "withCount",
]);

/**
 * `?priority=low` on a list whose allowlist has `priority` is almost always a caller who
 * meant `?filter[priority][eq]=low` — and silently ignoring it returns EVERY row, which
 * reads as "the filter matched everything". Refuse it, naming the syntax that works.
 *
 * A bare name that is a field of the entity but NOT on the filter allowlist is refused
 * too — the caller plainly meant that field — saying it is not filterable and listing
 * the fields that are. Any other unknown parameter — a cache-buster, a tracking tag, a
 * param some proxy appends — is left alone, as before.
 * TS-only (the other ports ignore unknown parameters): see docs/features/api-contract.md,
 * "TS-only filter extensions".
 */
function rejectBareFieldParams(query: Record<string, unknown>, allowlist: FilterAllowlist, table: AnyTable): void {
  for (const [key, value] of Object.entries(query)) {
    if (RESERVED_LIST_PARAMS.has(key)) continue;
    if (Object.hasOwn(allowlist, key)) {
      const shown = typeof value === "string" ? value : "<value>";
      throw new FilterParseError(
        "filter.bare_field",
        `"${key}" is a filterable field, but a bare ?${key}= parameter is not a filter. Use filter[${key}][eq]=${shown}.`,
        { field: key, expected: `filter[${key}][eq]=${shown}` },
      );
    }
    if (isEntityColumn(table, key)) {
      const allowed = Object.keys(allowlist);
      throw new FilterParseError(
        "filter.bare_field",
        `"${key}" is a field of this entity, but it is not @filterable, so it cannot be filtered on` +
          (allowed.length > 0 ? ` (filterable: ${allowed.join(", ")}).` : " (no field is filterable)."),
        { field: key, filterable: false, expected: `a filterable field — "${key}" is not @filterable`, allowed },
      );
    }
  }
}

/** Is `key` one of the table's (or view's) own columns? A Drizzle table exposes each
 *  column as a property keyed by its field name; anything else found there (a function,
 *  a symbol-backed config, a proxy that throws on an unknown key) is not a field. */
function isEntityColumn(table: AnyTable, key: string): boolean {
  if (table === null || typeof table !== "object") return false;
  try {
    const v: unknown = table[key];
    return is(v, Column) || is(v, DrizzleSQL.Aliased);
  } catch {
    return false;
  }
}


export function parseFilterParams(opts: ParseFilterOpts): ParseFilterResult {
  rejectBareFieldParams(opts.query, opts.allowlist, opts.table);
  const result: ParseFilterResult = {};

  const limit = parsePageBound(opts.query, "limit");
  if (limit !== undefined) result.limit = limit;
  const offset = parsePageBound(opts.query, "offset");
  if (offset !== undefined) result.offset = offset;

  if (opts.query.filter && typeof opts.query.filter === "object") {
    const where = parseNode(
      opts.query.filter as Record<string, unknown>,
      opts.table, opts.allowlist, opts.dialect,
      opts.maxNesting ?? DEFAULT_MAX_NESTING,
      opts.maxInListSize ?? DEFAULT_MAX_IN_LIST,
      0,
    );
    if (where) result.where = where;
  }

  if (typeof opts.query.sort === "string") {
    result.orderBy = parseSort(opts.query.sort, opts.table, opts.sortAllowlist);
  }

  if (typeof opts.query.search === "string" && opts.query.search !== "") {
    const term = `%${opts.query.search}%`;
    const stringCols = Object.entries(opts.allowlist)
      .filter(([, rule]) => (rule as FilterFieldRule).subType === "string")
      .map(([field]) => opts.table[field]);
    if (stringCols.length > 0) {
      // `?search` is a TS-only extension (docs/features/api-contract.md) and is
      // deliberately case-INSENSITIVE — it is a human search box, not the
      // contract's `like` operator (which is case-sensitive SQL LIKE, ADR-0049).
      // Postgres uses ILIKE; SQLite's native LIKE folds ASCII case by default,
      // which is the intended behavior here.
      const matcher = opts.dialect === "postgres" ? ilike : like;
      const parts = stringCols.map((col) => matcher(col, term));
      // or() is defined as returning SQL | undefined but will always return
      // SQL when given a non-empty array. parts[0] is always defined here
      // because stringCols.length > 0 guarantees at least one element.
      // biome-ignore lint/style/noNonNullAssertion: parts is guaranteed non-empty
      result.searchWhere = (parts.length === 1 ? parts[0] : or(...parts)) as SQL;
    }
  }

  return result;
}

function parseNode(
  node: Record<string, unknown>,
  table: AnyTable,
  allowlist: FilterAllowlist,
  dialect: "sqlite" | "postgres",
  maxNesting: number,
  maxInList: number,
  depth: number,
): SQL | undefined {
  if (depth > maxNesting) {
    throw new FilterParseError("filter.nesting_too_deep", `Filter nesting depth exceeds limit (${maxNesting}).`, { limit: maxNesting });
  }
  const parts: SQL[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "or") {
      const subs = ensureArray(value, "or").map((sub) =>
        parseNode(sub as Record<string, unknown>, table, allowlist, dialect, maxNesting, maxInList, depth + 1)
      ).filter((s): s is SQL => !!s);
      if (subs.length > 0) parts.push(or(...subs)!);
    } else if (key === "and") {
      const subs = ensureArray(value, "and").map((sub) =>
        parseNode(sub as Record<string, unknown>, table, allowlist, dialect, maxNesting, maxInList, depth + 1)
      ).filter((s): s is SQL => !!s);
      if (subs.length > 0) parts.push(and(...subs)!);
    } else {
      // key is a field name
      const rule = allowlist[key];
      if (!rule) {
        throw new FilterParseError("filter.unknown_field", `Unknown filter field "${key}".`, { field: key, allowed: Object.keys(allowlist) });
      }
      const col = table[key];
      if (col === undefined) {
        throw new FilterParseError("filter.unknown_field", `Table has no column for field "${key}".`, { field: key });
      }
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        for (const [opKey, opValue] of Object.entries(value)) {
          const expr = compileOp(col, rule, key, opKey, opValue, dialect, maxInList);
          if (expr) parts.push(expr);
        }
      } else {
        // Bare value = eq sugar
        const expr = compileOp(col, rule, key, "eq", value, dialect, maxInList);
        if (expr) parts.push(expr);
      }
    }
  }
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return and(...parts);
}

function compileOp(
  col: unknown,
  rule: FilterFieldRule,
  field: string,
  op: string,
  value: unknown,
  dialect: "sqlite" | "postgres",
  maxInList: number,
): SQL | undefined {
  if (!rule.ops.includes(op as FilterOp)) {
    throw new FilterParseError("filter.unsupported_op", `Op "${op}" not supported for field "${field}".`, { field, op, allowed: rule.ops });
  }
  switch (op as FilterOp) {
    case "eq":  return eq(col as any, coerce(value, rule, col, field, op));
    case "ne":  return ne(col as any, coerce(value, rule, col, field, op));
    case "gt":  return gt(col as any, coerce(value, rule, col, field, op));
    case "gte": return gte(col as any, coerce(value, rule, col, field, op));
    case "lt":  return lt(col as any, coerce(value, rule, col, field, op));
    case "lte": return lte(col as any, coerce(value, rule, col, field, op));
    case "in": {
      const list = String(value).split(",").map((v) => coerce(v.trim(), rule, col, field, op));
      if (list.length > maxInList) {
        throw new FilterParseError("filter.in_too_large", `In-list size ${list.length} exceeds limit ${maxInList}.`, { field, limit: maxInList });
      }
      return inArray(col as any, list);
    }
    case "like": {
      const s = String(value);
      if (s.startsWith("%") && !rule.leadingWildcard) {
        throw new FilterParseError("filter.leading_wildcard_disallowed", `Leading wildcard not allowed for field "${field}".`, { field });
      }
      // Cross-port contract (ADR-0049): `like` is case-SENSITIVE SQL LIKE —
      // verbatim author-supplied pattern, `%`/`_` wildcards. Postgres LIKE is
      // already case-sensitive. SQLite's built-in LIKE folds ASCII case by
      // default (and `PRAGMA case_sensitive_like` is connection-global on a
      // consumer-owned connection), so the sqlite branch lowers to GLOB with
      // an exactly-translated pattern instead.
      return dialect === "postgres"
        ? like(col as any, s)
        : sql`${col} GLOB ${likePatternToGlob(s)}`;
    }
    case "isNull": {
      // isNull's value is always coerced as boolean (true/false), regardless of the
      // field's declared subType — the operator is "is the value null?", not "is X
      // equal to null?". Field subtype is irrelevant.
      const b = coerceAs(value, "boolean", field, op) as boolean;
      return b ? isNull(col as any) : not(isNull(col as any));
    }
  }
}

/**
 * Translate a SQL LIKE pattern into an equivalent SQLite GLOB pattern:
 * `%` → `*`, `_` → `?`, and GLOB's own metacharacters (`*`, `?`, `[`) are
 * wrapped in single-character classes so they match literally. `]` is only
 * special inside a class, so it passes through. GLOB is case-sensitive,
 * which is why the sqlite `like` branch uses it (ADR-0049) — SQLite's
 * native LIKE folds ASCII case by default.
 */
export function likePatternToGlob(pattern: string): string {
  let out = "";
  for (const ch of pattern) {
    if (ch === "%") out += "*";
    else if (ch === "_") out += "?";
    else if (ch === "*") out += "[*]";
    else if (ch === "?") out += "[?]";
    else if (ch === "[") out += "[[]";
    else out += ch;
  }
  return out;
}

function invalidValue(
  field: string,
  op: string,
  s: string,
  expected: string,
  extra: Record<string, unknown> = {},
): FilterParseError {
  return new FilterParseError(
    "filter.invalid_value",
    `Field "${field}" op "${op}" requires ${expected}, got "${s}".`,
    { field, op, expected, ...extra },
  );
}

/** A Drizzle column's own enum members (`text(..., { enum })`, `pgEnum`), if it has them. */
function columnEnumValues(col: unknown): readonly string[] | undefined {
  const v = (col as { enumValues?: unknown } | null | undefined)?.enumValues;
  return Array.isArray(v) && v.length > 0 && v.every((m) => typeof m === "string") ? (v as string[]) : undefined;
}

/**
 * Refuse a value that cannot be the field's type BEFORE it is bound. Without this a
 * malformed date on SQLite compared as text and silently matched nothing (200 `[]`),
 * and on Postgres the driver refused the cast (a 500) — either way the caller could not
 * tell a typo from an empty result. The envelope is the cross-port `invalid_filter_value`,
 * carrying `op` and `expected` as the number/boolean checks already did.
 */
function assertWellFormed(s: string, rule: FilterFieldRule, col: unknown, field: string, op: string): void {
  const members = rule.enumValues ?? columnEnumValues(col);
  if (members !== undefined && !members.includes(s)) {
    throw invalidValue(field, op, s, `one of: ${members.join(", ")}`, { allowed: [...members] });
  }
  if (rule.format !== undefined) {
    if (!matchesFormat(rule.format, s)) throw invalidValue(field, op, s, FORMAT_EXPECTED[rule.format]);
  } else if (rule.subType === "datetime" && !matchesAnyTemporal(s)) {
    throw invalidValue(field, op, s, ANY_TEMPORAL_EXPECTED);
  }
}

/** Check a comparison value against the field's rule, then coerce it for binding. */
function coerce(value: unknown, rule: FilterFieldRule, col: unknown, field: string, op: string): unknown {
  if (value === null || value === undefined) return null;
  const s = typeof value === "string" ? value : String(value);
  assertWellFormed(s, rule, col, field, op);
  // A zoned timestamp bound is compared in the same UTC spelling the generated schemas
  // store (see utcIsoIfZoned): on SQLite/D1 the column is TEXT and compares as text. A
  // Date-bound (`dateValues`) column parses the instant itself and is left alone.
  if (rule.format === FIELD_SUBTYPE_TIMESTAMP && rule.dateValues !== true) {
    return coerceAs(utcIsoIfZoned(s), rule.subType, field, op, rule.dateValues);
  }
  return coerceAs(s, rule.subType, field, op, rule.dateValues);
}

function coerceAs(value: unknown, subType: string, field: string, op: string, dateValues?: boolean): unknown {
  if (value === null || value === undefined) return null;
  const s = typeof value === "string" ? value : String(value);
  switch (subType) {
    case "string":   return s;
    case "boolean":  {
      if (s === "true"  || s === "1") return true;
      if (s === "false" || s === "0") return false;
      throw new FilterParseError("filter.invalid_value", `Field "${field}" op "${op}" requires boolean, got "${s}".`, { field, op, expected: "boolean" });
    }
    case "number":   {
      // `Number("")` and `Number(" ")` are 0 — an empty bound is not the number zero.
      const n = s.trim() === "" ? Number.NaN : Number(s);
      if (!Number.isFinite(n)) {
        throw new FilterParseError("filter.invalid_value", `Field "${field}" op "${op}" requires number, got "${s}".`, { field, op, expected: "number" });
      }
      return n;
    }
    // Under codegen's Postgres-only `timestampMode: "date"` the Drizzle column is
    // Date-typed and calls `value.toISOString()` on any bound value, so passing the
    // raw qs string through threw `TypeError: value.toISOString is not a function`
    // for every op except isNull. The generated allowlist now carries `dateValues`
    // for exactly those columns (see FilterFieldRule), so the value is bound as a
    // real Date. In the default "string" mode — and for field.date / field.time,
    // which Drizzle types as strings under every dialect — the flag is absent and
    // the value stays a string, unchanged.
    case "datetime": {
      if (dateValues !== true) return s;
      const d = new Date(s);
      // `new Date("garbage")` yields an Invalid Date rather than throwing; binding
      // one would emit `NaN`-shaped SQL. Reject at the boundary, matching how the
      // number and boolean cases report a malformed value.
      if (Number.isNaN(d.getTime())) {
        throw new FilterParseError("filter.invalid_value", `Field "${field}" op "${op}" requires a date, got "${s}".`, { field, op, expected: "date" });
      }
      return d;
    }
    default: return s;
  }
}

function ensureArray(v: unknown, key: string): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    // qs.parse may produce { "0": ..., "1": ... } shape for filter[or][0]...
    return Object.values(v);
  }
  // Defensive — qs.parse normally produces an object/array; this branch is
  // only reachable if a caller hand-constructs a malformed query object.
  //
  // `field` (not `key`) because this maps to the cross-port `invalid_filter_value`
  // envelope, which REQUIRES `field` naming the offending filter key — here the
  // `or`/`and` connector that was handed a non-array.
  throw new FilterParseError("filter.invalid_value", `Expected array for "${key}".`, { field: key });
}

function parseSort(spec: string, table: AnyTable, sortAllowlist: SortAllowlist): SQLWrapper[] {
  const colonIdx = spec.indexOf(":");
  const field = colonIdx === -1 ? spec : spec.slice(0, colonIdx);
  if (!sortAllowlist[field]) {
    throw new FilterParseError(
      "sort.unknown_field",
      `Unknown sort field "${field}". The syntax is ${SORT_EXPECTED}.`,
      { field, expected: SORT_EXPECTED, allowed: Object.keys(sortAllowlist) },
    );
  }
  // `?sort=field` with no `:order` takes the field's DECLARED default order.
  //
  // This is the read side of `@sortableDefaultOrder`, and until now there was none.
  // The attribute was authored by an adopter, carried through the loader, and emitted
  // into the generated `<Entity>SortAllowlist` as `{ defaultOrder: "desc" }` — and then
  // nothing read it back. One door in, no door out: the adopter authored a promise the
  // product never kept, and every unqualified sort came back ascending regardless.
  //
  // Scoped deliberately to "field named, order omitted". Applying it when `?sort` is
  // ABSENT ENTIRELY would give every endpoint a default ordering it does not have
  // today — a behaviour change for every consumer, to honour an attribute about how a
  // FIELD sorts. The declaration says which way this column runs when you do not say;
  // it does not say which column to sort by.
  const orderRaw = sortOrderSpec(
    sortAllowlist,
    field,
    colonIdx === -1 ? undefined : spec.slice(colonIdx + 1),
  );
  const order = orderRaw.toLowerCase();
  if (order !== "asc" && order !== "desc") {
    throw new FilterParseError(
      "sort.invalid_order",
      `Sort order must be asc|desc, got "${orderRaw}". The syntax is ${SORT_EXPECTED}.`,
      { field, expected: SORT_EXPECTED, allowed: Object.keys(sortAllowlist) },
    );
  }
  const col = table[field];
  return [order === "asc" ? asc(col as any) : desc(col as any)];
}
