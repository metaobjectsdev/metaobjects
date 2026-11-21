import {
  is, Column, SQL as DrizzleSQL,
  eq, ne, gt, gte, lt, lte, inArray, like, ilike, isNull, not, and, or, sql,
  asc, desc,
  type SQL, type SQLWrapper,
} from "drizzle-orm";
import type { SqlDialect } from "../sql-dialect.js";
import type { FilterAllowlist, FilterFieldRule, SortAllowlist } from "./filter-allowlist.js";
import { FilterParseError } from "./list-params.js";
import { likePatternToGlob, parseListQuery, type FilterLeaf, type FilterNode, type FilterScalar, type ListSearch } from "./list-query.js";

// Re-exported so existing importers keep one door; the definitions live in the
// drizzle-free list-params and list-query modules, which the ObjectManager Fastify mount also uses.
export { FilterParseError, parsePageBound, pageLimit, ERROR_CODE_LIMIT_TOO_LARGE, type PageSize, PAGINATION_EXPECTED, RAW_VIEW_MAX_LIMIT, REPORT_MAX_ROWS, ReportTooLargeError, parseReportPage, SORT_EXPECTED } from "./list-params.js";
export {
  likePatternToGlob, parseListQuery, parseListQueryString, rawQueryOf, searchFields, DEFAULT_MAX_IN_LIST, DEFAULT_MAX_NESTING,
  type FilterLeaf, type FilterNode, type FilterScalar, type ListQuery, type ListSearch, type ListSort, type ParseListQueryOpts,
} from "./list-query.js";
import { FIELD_SUBTYPE_DECIMAL, FIELD_SUBTYPE_DURATION } from "@metaobjectsdev/metadata";
import { durationToStoredMicros, formatPostgresInterval, parseDurationLiteral } from "../duration-wire.js";

// biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch over user's Drizzle table
type AnyTable = any;

export interface ParseFilterOpts {
  query: Record<string, unknown>;
  table: AnyTable;
  allowlist: FilterAllowlist;
  sortAllowlist: SortAllowlist;
  dialect: SqlDialect;
  maxNesting?: number;
  maxInListSize?: number;
}

export interface ParseFilterResult {
  where?: SQL;
  orderBy?: SQLWrapper[];
  limit?: number;
  offset?: number;
  /** Search predicate — OR(case-insensitive '%term%') across @filterable text fields. */
  searchWhere?: SQL;
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

/** A Drizzle column's own enum members (`text(..., { enum })`, `pgEnum`), if it has them. */
function columnEnumValues(col: unknown): readonly string[] | undefined {
  const v = (col as { enumValues?: unknown } | null | undefined)?.enumValues;
  return Array.isArray(v) && v.length > 0 && v.every((m) => typeof m === "string") ? (v as string[]) : undefined;
}

/**
 * Parse a list query (`parseListQuery`, which raises every refusal) and compile it to
 * Drizzle for `opts.table` on `opts.dialect`.
 */
export function parseFilterParams(opts: ParseFilterOpts): ParseFilterResult {
  const table = opts.table;
  const parsed = parseListQuery({
    query: opts.query,
    allowlist: opts.allowlist,
    sortAllowlist: opts.sortAllowlist,
    isField: (name) => isEntityColumn(table, name),
    hasColumn: (name) => table[name] !== undefined,
    enumValuesOf: (name) => columnEnumValues(table[name]),
    ...(opts.maxNesting !== undefined ? { maxNesting: opts.maxNesting } : {}),
    ...(opts.maxInListSize !== undefined ? { maxInListSize: opts.maxInListSize } : {}),
  });
  const result: ParseFilterResult = {};
  if (parsed.limit !== undefined) result.limit = parsed.limit;
  if (parsed.offset !== undefined) result.offset = parsed.offset;
  if (parsed.filter !== undefined) result.where = compileFilterNode(parsed.filter, table, opts.allowlist, opts.dialect);
  if (parsed.sort !== undefined) result.orderBy = nullsAsLargest(table[parsed.sort.field], parsed.sort.order, opts.dialect);
  if (parsed.search !== undefined) result.searchWhere = compileSearch(parsed.search, table, opts.dialect);
  return result;
}

/** Compile a parsed filter tree to a Drizzle condition over `table`. */
export function compileFilterNode(node: FilterNode, table: AnyTable, allowlist: FilterAllowlist, dialect: SqlDialect): SQL {
  if ("and" in node) return and(...node.and.map((n) => compileFilterNode(n, table, allowlist, dialect))) as SQL;
  if ("or" in node) return or(...node.or.map((n) => compileFilterNode(n, table, allowlist, dialect))) as SQL;
  return compileLeaf(node, table[node.field], allowlist[node.field] as FilterFieldRule, dialect);
}

/**
 * `?search` is deliberately case-INSENSITIVE — a human search box, not the contract's `like`
 * operator (case-sensitive SQL LIKE, ADR-0049). Postgres uses ILIKE; SQLite's native LIKE
 * folds ASCII case, which is the intended behavior here. MySQL's LIKE follows the column's
 * collation (case-insensitive by default, case-sensitive on a `_bin` column), so it folds
 * both sides explicitly.
 */
function compileSearch(search: ListSearch, table: AnyTable, dialect: SqlDialect): SQL {
  const term = `%${search.term}%`;
  const parts = search.fields.map((field) => {
    const col = table[field];
    return dialect === "postgres" ? ilike(col, term)
      : dialect === "mysql" ? sql`LOWER(${col}) LIKE LOWER(${term})`
      : like(col, term);
  });
  return (parts.length === 1 ? parts[0] : or(...parts)) as SQL;
}

function compileLeaf(leaf: FilterLeaf, col: unknown, rule: FilterFieldRule, dialect: SqlDialect): SQL {
  // biome-ignore lint/suspicious/noExplicitAny: a column of the adopter's Drizzle table
  const c = col as any;
  const bind = (v: FilterScalar): unknown => bindOperand(v, rule, leaf, dialect);
  switch (leaf.op) {
    case "eq":  return eq(c, bind(leaf.value as FilterScalar));
    case "ne":  return ne(c, bind(leaf.value as FilterScalar));
    case "gt":  return gt(c, bind(leaf.value as FilterScalar));
    case "gte": return gte(c, bind(leaf.value as FilterScalar));
    case "lt":  return lt(c, bind(leaf.value as FilterScalar));
    case "lte": return lte(c, bind(leaf.value as FilterScalar));
    case "in":  return inArray(c, (leaf.value as readonly FilterScalar[]).map(bind));
    case "like": {
      const s = leaf.value as string;
      // Cross-port contract (ADR-0049): `like` is case-SENSITIVE SQL LIKE — verbatim
      // pattern, `%`/`_` wildcards. Postgres LIKE already is. SQLite's built-in LIKE folds
      // ASCII case by default (and `PRAGMA case_sensitive_like` is connection-global on a
      // consumer-owned connection), so sqlite lowers to GLOB with an exactly-translated
      // pattern. MySQL's LIKE follows the column's collation, so the pattern carries an
      // explicit binary collation.
      return dialect === "postgres"
        ? like(c, s)
        : dialect === "mysql"
          ? sql`${c} LIKE ${s} COLLATE utf8mb4_bin`
          : sql`${c} GLOB ${likePatternToGlob(s)}`;
    }
    case "isNull":
      return leaf.value === true ? isNull(c) : not(isNull(c));
  }
}

/**
 * Spell a checked operand the way the column binds it. A decimal operand is exact text
 * (ADR-0019 Amendment 1, W2); MySQL compares a DECIMAL column with a string operand as
 * DOUBLES, so there it is cast to a wide DECIMAL, and SQLite / D1 hold a decimal as a double
 * (W4) and order every number before any text, so there it is bound as the number it is. A
 * duration is the microsecond integer on SQLite / D1 / MySQL and the interval spelling on
 * Postgres (which refuses a signed ISO-8601 duration). A timestamp on a column emitted under
 * `timestampMode: "date"` (`dateValues`) binds a real `Date`: Drizzle calls `toISOString()`
 * on it.
 */
function bindOperand(v: FilterScalar, rule: FilterFieldRule, leaf: FilterLeaf, dialect: SqlDialect): unknown {
  if (rule.format === FIELD_SUBTYPE_DECIMAL) {
    if (dialect === "mysql") return sql`CAST(${v} AS DECIMAL(65,30))`;
    return dialect === "sqlite" ? Number(v) : v;
  }
  if (rule.format === FIELD_SUBTYPE_DURATION) {
    const micros = parseDurationLiteral(String(v)) as bigint;
    return dialect === "sqlite" || dialect === "mysql" ? durationToStoredMicros(micros) : formatPostgresInterval(micros);
  }
  if (rule.subType === "datetime" && rule.dateValues === true) {
    const d = new Date(String(v));
    // `new Date("garbage")` is an Invalid Date rather than a throw; binding one would emit
    // `NaN`-shaped SQL.
    if (Number.isNaN(d.getTime())) {
      throw new FilterParseError("filter.invalid_value", `Field "${leaf.field}" op "${leaf.op}" requires a date, got "${String(v)}".`, { field: leaf.field, op: leaf.op, expected: "date" });
    }
    return d;
  }
  return v;
}

/**
 * Order a column with nulls as LARGER than any value: ASC puts them last, DESC first, on
 * every engine. That is Postgres's own default; SQLite and MySQL put nulls first on ASC, so
 * a bare `ORDER BY col` answered the same list in a different order per engine. SQLite
 * (3.30+, D1 included) and Postgres take `NULLS FIRST/LAST`; MySQL has no such clause, so it
 * gets a leading `col IS NULL` key (0 for a value, 1 for null).
 */
function nullsAsLargest(col: SQLWrapper, order: "asc" | "desc", dialect: SqlDialect | undefined): SQLWrapper[] {
  if (dialect === "mysql") {
    return order === "asc"
      ? [asc(sql`(${col} IS NULL)`), asc(col)]
      : [desc(sql`(${col} IS NULL)`), desc(col)];
  }
  return [order === "asc" ? sql`${col} ASC NULLS LAST` : sql`${col} DESC NULLS FIRST`];
}
