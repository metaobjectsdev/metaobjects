import {
  eq, ne, gt, gte, lt, lte, inArray, like, ilike, isNull, not, and, or, asc, desc,
  type SQL, type SQLWrapper,
} from "drizzle-orm";
import type { FilterAllowlist, FilterOp, FilterFieldRule, SortAllowlist } from "./filter-allowlist.js";

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

export class FilterParseError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "FilterParseError";
  }
}

const DEFAULT_MAX_NESTING = 5;
const DEFAULT_MAX_IN_LIST = 100;

export function parseFilterParams(opts: ParseFilterOpts): ParseFilterResult {
  const result: ParseFilterResult = {};

  const limit = opts.query.limit;
  if (limit !== undefined) {
    const n = Number(limit);
    if (Number.isFinite(n)) result.limit = n;
  }
  const offset = opts.query.offset;
  if (offset !== undefined) {
    const n = Number(offset);
    if (Number.isFinite(n)) result.offset = n;
  }

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
      // Case-insensitive on Postgres (ilike), case-sensitive on SQLite (like) —
      // matches the dispatch the existing [like] op uses (parseNode, below).
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
    case "eq":  return eq(col as any, coerce(value, rule.subType, field, op));
    case "ne":  return ne(col as any, coerce(value, rule.subType, field, op));
    case "gt":  return gt(col as any, coerce(value, rule.subType, field, op));
    case "gte": return gte(col as any, coerce(value, rule.subType, field, op));
    case "lt":  return lt(col as any, coerce(value, rule.subType, field, op));
    case "lte": return lte(col as any, coerce(value, rule.subType, field, op));
    case "in": {
      const list = String(value).split(",").map((v) => coerce(v.trim(), rule.subType, field, op));
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
      return dialect === "postgres" ? ilike(col as any, s) : like(col as any, s);
    }
    case "isNull": {
      // isNull's value is always coerced as boolean (true/false), regardless of the
      // field's declared subType — the operator is "is the value null?", not "is X
      // equal to null?". Field subtype is irrelevant.
      const b = coerce(value, "boolean", field, op) as boolean;
      return b ? isNull(col as any) : not(isNull(col as any));
    }
  }
}

function coerce(value: unknown, subType: string, field: string, op: string): unknown {
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
      const n = Number(s);
      if (!Number.isFinite(n)) {
        throw new FilterParseError("filter.invalid_value", `Field "${field}" op "${op}" requires number, got "${s}".`, { field, op, expected: "number" });
      }
      return n;
    }
    // KNOWN LIMITATION (codegen-ts's `timestampMode: "date"` config option,
    // Important-4 assessment): this keeps the qs value a STRING unconditionally.
    // Under codegen's Postgres-only "date" mode the Drizzle column is Date-typed
    // and calls `value.toISOString()` on any bound value — comparing it against a
    // string here throws `TypeError: value.toISOString is not a function` for
    // every op except isNull (eq/ne/gt/gte/lt/lte/in all bind through the same
    // typed column). Not reachable in the default "string" mode (the only mode
    // this parser was originally designed against). A correct fix needs the
    // entity's `timestampMode` threaded from codegen into the generated
    // allowlist or mount options so this function can `new Date(s)` — deferred
    // as a separate, more invasive change; do not filter a "date"-mode timestamp
    // field until that lands.
    case "datetime": return s;
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
  throw new FilterParseError("filter.invalid_value", `Expected array for "${key}".`, { key });
}

function parseSort(spec: string, table: AnyTable, sortAllowlist: SortAllowlist): SQLWrapper[] {
  const colonIdx = spec.indexOf(":");
  const field = colonIdx === -1 ? spec : spec.slice(0, colonIdx);
  const orderRaw = colonIdx === -1 ? "asc" : spec.slice(colonIdx + 1);
  const order = orderRaw.toLowerCase();
  if (!sortAllowlist[field]) {
    throw new FilterParseError("sort.unknown_field", `Unknown sort field "${field}".`, { field, allowed: Object.keys(sortAllowlist) });
  }
  if (order !== "asc" && order !== "desc") {
    throw new FilterParseError("sort.invalid_order", `Sort order must be asc|desc, got "${orderRaw}".`, { expected: "asc | desc" });
  }
  const col = table[field];
  return [order === "asc" ? asc(col as any) : desc(col as any)];
}
