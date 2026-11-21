/**
 * The list query a REST list route reads, parsed into a port-neutral form BEFORE any query
 * library sees it: a filter tree, a search, a sort, a page. Every refusal of the REST standard
 * is raised here (`docs/features/api-contract.md`, "List handling"), so the Drizzle mounts and
 * the ObjectManager mount refuse a request identically and differ only in how they run the
 * tree. Deliberately free of drizzle-orm (an OPTIONAL peer), like `list-params.ts`.
 *
 * `fixtures/list-query-conformance/` pins this function's answers — a query string and a
 * field list in, a tree or a named error out — for every port.
 */

import qs from "qs";
import { FIELD_SUBTYPE_DECIMAL, FIELD_SUBTYPE_DURATION, FIELD_SUBTYPE_TIMESTAMP } from "@metaobjectsdev/metadata";
import type { FilterAllowlist, FilterFieldRule, FilterOp, SortAllowlist } from "./filter-allowlist.js";
import { sortOrderSpec } from "./filter-allowlist.js";
import { FilterParseError, parsePageBound, SORT_EXPECTED } from "./list-params.js";
import {
  ANY_TEMPORAL_EXPECTED, FORMAT_EXPECTED, PLUS_OFFSET_HINT,
  looksLikeUnencodedPlusOffset, matchesAnyTemporal, matchesFormat, utcIsoIfZoned, utcIsoInstant,
} from "./filter-value-format.js";
import { canonicalDecimal } from "../decimal-wire.js";
import { DURATION_MICROS_MAX, DURATION_MICROS_MIN, parseDurationLiteral } from "../duration-wire.js";

/** A scalar operand after its checks: a number or boolean as that type, everything else text. */
export type FilterScalar = string | number | boolean;

/** One comparison. `in` carries a list; `isNull` a boolean; every other op one scalar. */
export interface FilterLeaf {
  readonly field: string;
  readonly op: FilterOp;
  readonly value: FilterScalar | readonly FilterScalar[];
}

/** A filter tree: a comparison, or an AND / OR of subtrees (never empty). */
export type FilterNode = FilterLeaf | { readonly and: readonly FilterNode[] } | { readonly or: readonly FilterNode[] };

export interface ListSearch {
  /** The term as sent; matched case-insensitively as a substring. */
  readonly term: string;
  /** The `@filterable` text fields it is matched against (OR), in allowlist order. */
  readonly fields: readonly string[];
}

export interface ListSort {
  readonly field: string;
  readonly order: "asc" | "desc";
}

export interface ListQuery {
  readonly filter?: FilterNode;
  readonly search?: ListSearch;
  readonly sort?: ListSort;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ParseListQueryOpts {
  /** The bracketed query, as `parseListQueryString` returns it. */
  readonly query: Record<string, unknown>;
  readonly allowlist: FilterAllowlist;
  readonly sortAllowlist: SortAllowlist;
  /**
   * Is `name` a field of the entity (a column of the table or view the list reads)? A bare
   * `?name=` naming one that is not filterable is refused as `filter.bare_field`; absent, only
   * a bare FILTERABLE field is refused.
   */
  readonly isField?: (name: string) => boolean;
  /** A field on the allowlist the read source has no column for (an allowlist out of step
   *  with its table) is `invalid_filter_field`. Absent, every allowlisted field has one. */
  readonly hasColumn?: (name: string) => boolean;
  /** The enum members of a field whose rule carries none (an allowlist generated before
   *  `enumValues` existed: the Drizzle column's own members). */
  readonly enumValuesOf?: (name: string) => readonly string[] | undefined;
  readonly maxNesting?: number;
  readonly maxInListSize?: number;
}

/** The deepest `or` / `and` nesting a filter may use; one level deeper is `filter.nesting_too_deep`. */
export const DEFAULT_MAX_NESTING = 5;
/** The most elements an `in` list may carry; one more is `filter.in_too_large`. */
export const DEFAULT_MAX_IN_LIST = 100;

/**
 * Parse a raw query string (no leading `?`) into the bracketed tree the list routes read.
 *
 * qs's defaults would cut the tree short: past 5 brackets it keeps the rest of a key as one
 * literal string (`filter[or][0][or][0][or][0][a][eq]` became a field named `[0][a][eq]`, an
 * `invalid_filter_field` naming a field nobody sent), so the nesting cap could never be reached
 * and a three-level filter was refused for the wrong reason. The depth here admits one level
 * past the cap — two brackets per level plus the field and the op — so a too-deep filter is
 * answered as one, and an index above 20 stays an index rather than becoming an object key.
 */
export function parseListQueryString(raw: string, maxNesting: number = DEFAULT_MAX_NESTING): Record<string, unknown> {
  return qs.parse(raw, { depth: 2 * (maxNesting + 1) + 3, arrayLimit: DEFAULT_MAX_IN_LIST }) as Record<string, unknown>;
}

/** The query string of a request URL (`/x?a=1` → `a=1`; no `?` → ""). */
export function rawQueryOf(url: string | undefined): string {
  if (url === undefined) return "";
  const i = url.indexOf("?");
  return i === -1 ? "" : url.slice(i + 1);
}

/** Top-level list-query parameters this parser (or the mount around it) reads. A
 *  filterable field that happens to share one of these names is addressed only through
 *  `filter[<name>]`, so the bare-field check below never claims them. */
const RESERVED_LIST_PARAMS: ReadonlySet<string> = new Set([
  "filter", "sort", "limit", "offset", "search", "withCount",
]);

/**
 * Parse and check a list query. The checks run in a fixed order, which is part of the
 * contract when a request carries more than one fault: bare field parameters, `limit`,
 * `offset`, the filter (depth-first, in the order its keys were sent), `sort`, `search`.
 */
export function parseListQuery(opts: ParseListQueryOpts): ListQuery {
  rejectBareFieldParams(opts.query, opts.allowlist, opts.isField);
  const out: { -readonly [K in keyof ListQuery]: ListQuery[K] } = {};

  const limit = parsePageBound(opts.query, "limit");
  if (limit !== undefined) out.limit = limit;
  const offset = parsePageBound(opts.query, "offset");
  if (offset !== undefined) out.offset = offset;

  if (opts.query.filter && typeof opts.query.filter === "object") {
    const filter = parseNode(opts.query.filter as Record<string, unknown>, opts, 0);
    if (filter) out.filter = filter;
  }

  if (typeof opts.query.sort === "string") out.sort = parseSort(opts.query.sort, opts.sortAllowlist);

  if (typeof opts.query.search === "string" && opts.query.search !== "") {
    const fields = searchFields(opts.allowlist);
    if (fields.length > 0) out.search = { term: opts.query.search, fields };
  }
  return out;
}

/**
 * The fields `?search` matches: `@filterable` text fields. A rule with a `format` (uuid, …)
 * is a typed column that is a string on the wire, not text — a case-insensitive LIKE on a
 * Postgres uuid column is "operator does not exist" (a 500).
 */
export function searchFields(allowlist: FilterAllowlist): string[] {
  return Object.entries(allowlist)
    // A search term is a `like` pattern, so only a field whose band has `like` takes part: a
    // typed column spelled as a string (uuid, a `format`) and an int-backed enum (an integer
    // column, no `like` in its band) would make Postgres answer "operator does not exist".
    .filter(([, rule]) => rule.subType === "string" && rule.format === undefined && rule.ops.includes("like"))
    .map(([field]) => field);
}

/**
 * `?priority=low` on a list whose allowlist has `priority` is almost always a caller who
 * meant `?filter[priority][eq]=low` — and silently ignoring it returns EVERY row, which
 * reads as "the filter matched everything". Refuse it, naming the syntax that works.
 *
 * A bare name that is a field of the entity but NOT on the filter allowlist is refused
 * too — the caller plainly meant that field — saying it is not filterable and listing
 * the fields that are. Any other unknown parameter — a cache-buster, a tracking tag, a
 * param some proxy appends — is left alone.
 */
function rejectBareFieldParams(
  query: Record<string, unknown>,
  allowlist: FilterAllowlist,
  isField: ((name: string) => boolean) | undefined,
): void {
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
    if (isField?.(key) === true) {
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

function parseNode(node: Record<string, unknown>, opts: ParseListQueryOpts, depth: number): FilterNode | undefined {
  const maxNesting = opts.maxNesting ?? DEFAULT_MAX_NESTING;
  if (depth > maxNesting) {
    throw new FilterParseError("filter.nesting_too_deep", `Filter nesting depth exceeds limit (${maxNesting}).`, { limit: maxNesting });
  }
  const parts: FilterNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "or" || key === "and") {
      const subs = ensureArray(value, key)
        .map((sub) => parseNode(asNode(sub, key), opts, depth + 1))
        .filter((s): s is FilterNode => s !== undefined);
      if (subs.length === 0) continue;
      // One branch is that branch: `or` of one condition is the condition.
      parts.push(subs.length === 1 ? (subs[0] as FilterNode) : key === "or" ? { or: subs } : { and: subs });
      continue;
    }
    const rule = opts.allowlist[key];
    if (!rule) {
      throw new FilterParseError("filter.unknown_field", `Unknown filter field "${key}".`, { field: key, allowed: Object.keys(opts.allowlist) });
    }
    if (opts.hasColumn !== undefined && !opts.hasColumn(key)) {
      throw new FilterParseError("filter.unknown_field", `Table has no column for field "${key}".`, { field: key });
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [op, operand] of Object.entries(value)) parts.push(leaf(key, rule, op, operand, opts));
    } else {
      // A bare value is `eq` sugar.
      parts.push(leaf(key, rule, "eq", value, opts));
    }
  }
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : { and: parts };
}

/** A combinator's branch must itself be a filter object; a scalar there (`filter[or][0]=x`)
 *  names no field. */
function asNode(sub: unknown, key: string): Record<string, unknown> {
  if (sub !== null && typeof sub === "object" && !Array.isArray(sub)) return sub as Record<string, unknown>;
  throw new FilterParseError("filter.invalid_value", `Each "${key}" branch must be a filter object.`, { field: key });
}

function ensureArray(v: unknown, key: string): unknown[] {
  if (Array.isArray(v)) return v;
  // qs gives `{ "0": …, "1": … }` for sparse or very large indexes; integer keys iterate
  // in ascending order, so the branches keep their numeric order.
  if (v && typeof v === "object") return Object.values(v);
  // `field` (not `key`) because this is the cross-port `invalid_filter_value` envelope,
  // which REQUIRES `field` naming the offending filter key — here the connector.
  throw new FilterParseError("filter.invalid_value", `Expected array for "${key}".`, { field: key });
}

function leaf(field: string, rule: FilterFieldRule, op: string, operand: unknown, opts: ParseListQueryOpts): FilterLeaf {
  if (!rule.ops.includes(op as FilterOp)) {
    throw new FilterParseError("filter.unsupported_op", `Op "${op}" not supported for field "${field}".`, { field, op, allowed: rule.ops });
  }
  const filterOp = op as FilterOp;
  switch (filterOp) {
    case "in": {
      const maxInList = opts.maxInListSize ?? DEFAULT_MAX_IN_LIST;
      const list = String(operand).split(",").map((v) => operandOf(v.trim(), rule, field, op, opts));
      if (list.length > maxInList) {
        throw new FilterParseError("filter.in_too_large", `In-list size ${list.length} exceeds limit ${maxInList}.`, { field, limit: maxInList });
      }
      return { field, op: filterOp, value: list };
    }
    case "like": {
      const s = String(operand);
      if (s.startsWith("%") && !rule.leadingWildcard) {
        throw new FilterParseError("filter.leading_wildcard_disallowed", `Leading wildcard not allowed for field "${field}".`, { field });
      }
      // `like` is case-SENSITIVE SQL LIKE (ADR-0049): the pattern is kept verbatim.
      return { field, op: filterOp, value: s };
    }
    case "isNull":
      // The operand is "is the value null?" — a boolean whatever the field's type.
      return { field, op: filterOp, value: asBoolean(operand, field, op) };
    default:
      return { field, op: filterOp, value: operandOf(operand, rule, field, op, opts) };
  }
}

/** `expected` for a non-whole bound on an integer-valued field (`integer: true`). */
const INTEGER_EXPECTED = "integer (a whole number)";
const DURATION_IN_RANGE = "duration within the 64-bit microsecond range";

function invalidValue(field: string, op: string, s: string, expected: string, extra: Record<string, unknown> = {}): FilterParseError {
  const hint = typeof extra["hint"] === "string" ? ` Hint: ${extra["hint"]}.` : "";
  return new FilterParseError(
    "filter.invalid_value",
    `Field "${field}" op "${op}" requires ${expected}, got "${s}".${hint}`,
    { field, op, expected, ...extra },
  );
}

/**
 * Check a comparison operand against the field's rule and give it its neutral form: a
 * number or boolean as that type; a decimal as its canonical text (never through a double,
 * ADR-0019 Amendment 1); an instant timestamp in the stored UTC spelling (a zoneless or
 * date-only bound read as UTC), any other timestamp with only a zoned bound rewritten to
 * UTC; everything else as sent. Refusing a malformed operand here is what keeps SQLite from
 * comparing it as text (a silent `[]`) and Postgres from failing the cast (a 500).
 */
function operandOf(value: unknown, rule: FilterFieldRule, field: string, op: string, opts: ParseListQueryOpts): FilterScalar {
  const s = typeof value === "string" ? value : String(value);
  const members = rule.enumValues ?? opts.enumValuesOf?.(field);
  if (members !== undefined && !members.includes(s)) {
    throw invalidValue(field, op, s, `one of: ${members.join(", ")}`, { allowed: [...members] });
  }
  if (rule.format !== undefined) {
    if (!matchesFormat(rule.format, s)) {
      // `filter[dueAt][lt]=2026-10-06T00:00:00+00:00` sent unencoded arrives with a space
      // where the `+` was; the answer names the fix.
      const hint = rule.format === FIELD_SUBTYPE_TIMESTAMP && looksLikeUnencodedPlusOffset(s) ? { hint: PLUS_OFFSET_HINT } : {};
      throw invalidValue(field, op, s, FORMAT_EXPECTED[rule.format], hint);
    }
  } else if (rule.subType === "datetime" && !matchesAnyTemporal(s)) {
    throw invalidValue(field, op, s, ANY_TEMPORAL_EXPECTED);
  }
  if (rule.format === FIELD_SUBTYPE_DECIMAL) return canonicalDecimal(s) as string;
  if (rule.format === FIELD_SUBTYPE_DURATION) {
    // A well-formed span past 64 bits of microseconds is no stored value on any database.
    const micros = parseDurationLiteral(s) as bigint;
    if (micros > DURATION_MICROS_MAX || micros < DURATION_MICROS_MIN) throw invalidValue(field, op, s, DURATION_IN_RANGE);
    return s;
  }
  if (rule.format === FIELD_SUBTYPE_TIMESTAMP) return rule.instant === true ? utcIsoInstant(s) : utcIsoIfZoned(s);
  switch (rule.subType) {
    case "boolean":
      return asBoolean(s, field, op);
    case "number": {
      // `Number("")` and `Number(" ")` are 0 — an empty bound is not the number zero.
      const n = s.trim() === "" ? Number.NaN : Number(s);
      if (!Number.isFinite(n)) {
        throw new FilterParseError("filter.invalid_value", `Field "${field}" op "${op}" requires number, got "${s}".`, { field, op, expected: "number" });
      }
      // field.int / field.long / field.currency: a fractional bound is not a value of the field.
      if (rule.integer === true && !Number.isInteger(n)) throw invalidValue(field, op, s, INTEGER_EXPECTED);
      return n;
    }
    default:
      return s;
  }
}

function asBoolean(value: unknown, field: string, op: string): boolean {
  const s = typeof value === "string" ? value : String(value);
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  throw new FilterParseError("filter.invalid_value", `Field "${field}" op "${op}" requires boolean, got "${s}".`, { field, op, expected: "boolean" });
}

function parseSort(spec: string, sortAllowlist: SortAllowlist): ListSort {
  const colonIdx = spec.indexOf(":");
  const field = colonIdx === -1 ? spec : spec.slice(0, colonIdx);
  if (!sortAllowlist[field]) {
    throw new FilterParseError(
      "sort.unknown_field",
      `Unknown sort field "${field}". The syntax is ${SORT_EXPECTED}.`,
      { field, expected: SORT_EXPECTED, allowed: Object.keys(sortAllowlist) },
    );
  }
  // `?sort=field` with no `:order` takes the field's DECLARED `@sortableDefaultOrder`.
  // Applying it when `?sort` is absent entirely would give every endpoint an ordering it
  // does not have: the declaration says which way a column runs, not which column to sort by.
  const orderRaw = sortOrderSpec(sortAllowlist, field, colonIdx === -1 ? undefined : spec.slice(colonIdx + 1));
  const order = orderRaw.toLowerCase();
  if (order !== "asc" && order !== "desc") {
    throw new FilterParseError(
      "sort.invalid_order",
      `Sort order must be asc|desc, got "${orderRaw}". The syntax is ${SORT_EXPECTED}.`,
      { field, expected: SORT_EXPECTED, allowed: Object.keys(sortAllowlist) },
    );
  }
  return { field, order };
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
