/**
 * One list request, read against the LOADED MODEL.
 *
 * The generated routes get a per-entity `<Entity>FilterAllowlist` and `<Entity>SortAllowlist`
 * baked in at `meta gen` time. This file derives the same two allowlists from the metadata
 * node on every request, with the same rules:
 *
 *   filterable   a field with `@filterable: true`
 *   operators    `opsForField(field)`, the one band every port shares
 *   sortable     `@sortable: true`, or `@filterable: true` unless `@sortable: false`
 *   page size    `api.pagination` from `.metaobjects/config.json`, carried on the loaded root
 *
 * Nothing here writes SQL. The result is an ObjectManager `Filter` and `QueryOpts`: field
 * names that were looked up in the model, operators from a closed set, and values that were
 * parsed to the field's own type. ObjectManager resolves the column names and the driver
 * binds the values. A request cannot name a column, only a field the model already declares
 * as filterable.
 */
import {
  FIELD_ATTR_FILTERABLE,
  FIELD_ATTR_SORTABLE,
  FIELD_ATTR_SORTABLE_DEFAULT_ORDER,
  FIELD_ATTR_VALUES,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_STRING,
  FILTER_OP_EQ,
  FILTER_OP_GT,
  FILTER_OP_GTE,
  FILTER_OP_IN,
  FILTER_OP_IS_NULL,
  FILTER_OP_LIKE,
  FILTER_OP_LT,
  FILTER_OP_LTE,
  FILTER_OP_NE,
  opsForField,
  VIEW_SUBTYPE_PASSWORD,
  type ApiPagination,
  type FilterOp,
  type MetaField,
  type MetaObject,
} from "@metaobjectsdev/metadata";
import type { Filter, FilterValue, QueryOpts } from "@metaobjectsdev/runtime-ts";

/** The wire `error` codes of the list contract (docs/features/api-contract.md). */
export const ERROR_INVALID_FILTER_FIELD = "invalid_filter_field";
export const ERROR_INVALID_FILTER_OP = "invalid_filter_op";
export const ERROR_INVALID_FILTER_VALUE = "invalid_filter_value";
export const ERROR_INVALID_SORT = "invalid_sort";
export const ERROR_INVALID_PAGE_BOUND = "pagination.invalid_value";
export const ERROR_LIMIT_TOO_LARGE = "limit_too_large";
export const ERROR_LEADING_WILDCARD = "filter.leading_wildcard_disallowed";
export const ERROR_IN_TOO_LARGE = "filter.in_too_large";

const SORT_EXPECTED = "sort=<field>:asc|desc";
const PAGE_BOUND_EXPECTED = "a non-negative integer (0 or more)";
const SORT_ORDERS = ["asc", "desc"] as const;
type SortOrder = (typeof SORT_ORDERS)[number];

/** The longest `in` list a request may send; the generated routes use the same ceiling. */
const MAX_IN_LIST = 100;

/** A request the model does not allow. `details` is spread into the 400 body. */
export class ListQueryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ListQueryError";
  }
}

/** What one list request asks for, in ObjectManager's terms. */
export interface ListQuery {
  readonly filter: Filter | undefined;
  readonly opts: QueryOpts;
  readonly withCount: boolean;
}

/**
 * How a filter value of each field subtype is read from the query string. A subtype that
 * is not here cannot be filtered by this mount, and `assertFilterableSubTypes` says so when
 * the model loads instead of the list quietly ignoring a `@filterable` the author wrote.
 */
type ValueReader = (raw: string, field: MetaField) => string | number | boolean | undefined;

const VALUE_READERS: Readonly<Record<string, ValueReader>> = {
  [FIELD_SUBTYPE_STRING]: (raw) => raw,
  [FIELD_SUBTYPE_INT]: readInteger,
  [FIELD_SUBTYPE_LONG]: readInteger,
  [FIELD_SUBTYPE_CURRENCY]: readInteger,
  [FIELD_SUBTYPE_DOUBLE]: readNumber,
  [FIELD_SUBTYPE_FLOAT]: readNumber,
  [FIELD_SUBTYPE_DECIMAL]: readDecimal,
  [FIELD_SUBTYPE_BOOLEAN]: readBoolean,
  [FIELD_SUBTYPE_DATE]: readDate,
  [FIELD_SUBTYPE_ENUM]: readEnumMember,
};

const EXPECTED_BY_SUBTYPE: Readonly<Record<string, string>> = {
  [FIELD_SUBTYPE_INT]: "a whole number",
  [FIELD_SUBTYPE_LONG]: "a whole number",
  [FIELD_SUBTYPE_CURRENCY]: "a whole number of minor units",
  [FIELD_SUBTYPE_DOUBLE]: "a number",
  [FIELD_SUBTYPE_FLOAT]: "a number",
  [FIELD_SUBTYPE_DECIMAL]: "a decimal number with no exponent",
  [FIELD_SUBTYPE_BOOLEAN]: "true or false",
  [FIELD_SUBTYPE_DATE]: "a date (YYYY-MM-DD)",
};

function readInteger(raw: string): number | undefined {
  const n = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(n) ? n : undefined;
}

function readNumber(raw: string): number | undefined {
  const n = raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** A decimal stays the digits the caller sent: it is bound as text, never through a double. */
function readDecimal(raw: string): string | undefined {
  return /^-?\d+(\.\d+)?$/.test(raw) ? raw : undefined;
}

function readBoolean(raw: string): boolean | undefined {
  return raw === "true" ? true : raw === "false" ? false : undefined;
}

export function readDate(raw: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const parsed = new Date(`${raw}T00:00:00Z`);
  // `2026-02-31` parses (it rolls over to March); a real date prints back unchanged.
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw ? raw : undefined;
}

function readEnumMember(raw: string, field: MetaField): string | undefined {
  return enumMembers(field).includes(raw) ? raw : undefined;
}

/** The declared members of a `field.enum` (resolving read: the enum may be inherited). */
export function enumMembers(field: MetaField): readonly string[] {
  const values = field.attr(FIELD_ATTR_VALUES);
  return Array.isArray(values) ? values.map(String) : [];
}

/**
 * True for a credential: a field that declares a `view.password`, the one place the
 * metamodel says a value is secret. No route here reads or writes one, as no generated
 * route does: a CRUD route cannot hash it on the way in and must not show it on the way
 * out. The application writes it through its own code.
 */
export function isCredential(field: MetaField): boolean {
  return field.views().some((view) => view.subType === VIEW_SUBTYPE_PASSWORD);
}

/**
 * The fields a list may be filtered on: those the model marks `@filterable`, less any
 * credential. A filter on a value no response shows would still read it out, one `like`
 * prefix at a time.
 */
function filterableFields(entity: MetaObject): ReadonlyMap<string, MetaField> {
  const out = new Map<string, MetaField>();
  for (const field of entity.fields()) {
    if (field.attr(FIELD_ATTR_FILTERABLE) === true && !isCredential(field)) out.set(field.name, field);
  }
  return out;
}

/**
 * The fields a list may be sorted on: `@sortable`, which follows `@filterable` when unset.
 * Never a credential: the order of the rows would say how their secrets compare.
 */
function sortableFields(entity: MetaObject): ReadonlyMap<string, MetaField> {
  const out = new Map<string, MetaField>();
  for (const field of entity.fields()) {
    if (isCredential(field)) continue;
    const sortable = field.attr(FIELD_ATTR_SORTABLE);
    if (sortable === true || (sortable !== false && field.attr(FIELD_ATTR_FILTERABLE) === true)) {
      out.set(field.name, field);
    }
  }
  return out;
}

/**
 * Refuse a model this mount cannot serve faithfully: a `@filterable` field whose subtype
 * has no value reader here. Called once per load, so the author hears about it at startup.
 */
export function assertFilterableSubTypes(entity: MetaObject): void {
  for (const field of filterableFields(entity).values()) {
    if (VALUE_READERS[field.subType] === undefined) {
      throw new Error(
        `${entity.name}.${field.name} is @filterable, but this example reads no filter value for ` +
          `field.${field.subType} (it reads: ${Object.keys(VALUE_READERS).join(", ")}).`,
      );
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readValue(field: MetaField, op: string, raw: unknown): string | number | boolean {
  const reader = VALUE_READERS[field.subType];
  const text = typeof raw === "string" ? raw : undefined;
  const value = reader === undefined || text === undefined ? undefined : reader(text, field);
  if (value === undefined) {
    const members = field.subType === FIELD_SUBTYPE_ENUM ? enumMembers(field) : undefined;
    const expected = members !== undefined ? `one of ${members.join(", ")}` : EXPECTED_BY_SUBTYPE[field.subType];
    throw new ListQueryError(
      ERROR_INVALID_FILTER_VALUE,
      `filter[${field.name}][${op}] is not a valid ${field.subType} value.`,
      { field: field.name, op, ...(expected !== undefined ? { expected } : {}), ...(members !== undefined ? { allowed: members } : {}) },
    );
  }
  return value;
}

/** One `filter[field][op]=value` as an ObjectManager clause on that field. */
function clause(field: MetaField, op: FilterOp, raw: unknown): FilterValue {
  switch (op) {
    case FILTER_OP_EQ: return { $eq: readValue(field, op, raw) };
    case FILTER_OP_NE: return { $ne: readValue(field, op, raw) };
    case FILTER_OP_GT: return { $gt: orderable(readValue(field, op, raw)) };
    case FILTER_OP_GTE: return { $gte: orderable(readValue(field, op, raw)) };
    case FILTER_OP_LT: return { $lt: orderable(readValue(field, op, raw)) };
    case FILTER_OP_LTE: return { $lte: orderable(readValue(field, op, raw)) };
    case FILTER_OP_IN: {
      const parts = typeof raw === "string" ? raw.split(",").map((p) => p.trim()) : [];
      if (parts.length > MAX_IN_LIST) {
        throw new ListQueryError(ERROR_IN_TOO_LARGE, `In-list size ${parts.length} exceeds limit ${MAX_IN_LIST}.`, {
          field: field.name, limit: MAX_IN_LIST,
        });
      }
      return { $in: parts.map((p) => orderable(readValue(field, op, p))) };
    }
    case FILTER_OP_LIKE: {
      const pattern = typeof raw === "string" ? raw : "";
      // An unanchored LIKE cannot use an index; the generated allowlist refuses it too.
      if (pattern.startsWith("%")) {
        throw new ListQueryError(ERROR_LEADING_WILDCARD, `Leading wildcard not allowed for field "${field.name}".`, {
          field: field.name,
        });
      }
      return { $like: pattern };
    }
    case FILTER_OP_IS_NULL: {
      const flag = typeof raw === "string" ? readBoolean(raw) : undefined;
      if (flag === undefined) {
        throw new ListQueryError(ERROR_INVALID_FILTER_VALUE, `filter[${field.name}][${op}] must be true or false.`, {
          field: field.name, op, expected: "true or false",
        });
      }
      return { $isNull: flag };
    }
    default:
      // The operator band can name an operator this mount does not lower (the two
      // null-safe comparisons); refuse it by name rather than ignore it.
      throw new ListQueryError(ERROR_INVALID_FILTER_OP, `Op "${op}" is not served by this mount.`, { field: field.name, op });
  }
}

/** Ordering operators and `in` take a string or a number; a boolean field never offers them. */
function orderable(value: string | number | boolean): string | number {
  if (typeof value === "boolean") throw new Error("a boolean value reached an ordering operator");
  return value;
}

function readFilter(entity: MetaObject, raw: unknown): Filter | undefined {
  if (raw === undefined) return undefined;
  const allowed = filterableFields(entity);
  if (!isRecord(raw)) {
    throw new ListQueryError(ERROR_INVALID_FILTER_FIELD, "filter must be filter[<field>][<op>]=<value>.", {
      field: "", allowed: [...allowed.keys()],
    });
  }
  // One clause per (field, operator). ObjectManager reads only the first operator of a
  // clause object, so a range (`gte` and `lte` on one field) is two clauses under `$and`.
  const clauses: Filter[] = [];
  for (const [name, spec] of Object.entries(raw)) {
    const field = allowed.get(name);
    if (field === undefined) {
      throw new ListQueryError(ERROR_INVALID_FILTER_FIELD, `Unknown filter field "${name}".`, {
        field: name, allowed: [...allowed.keys()],
      });
    }
    const ops = opsForField(field);
    // A bare value is `eq`.
    const byOp = isRecord(spec) ? spec : { [FILTER_OP_EQ]: spec };
    for (const [opName, value] of Object.entries(byOp)) {
      const op = ops.find((o) => o === opName);
      if (op === undefined) {
        throw new ListQueryError(ERROR_INVALID_FILTER_OP, `Op "${opName}" not supported for field "${name}".`, {
          field: name, op: opName, allowed: ops,
        });
      }
      clauses.push({ [name]: clause(field, op, value) });
    }
  }
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

function isSortOrder(value: string): value is SortOrder {
  return (SORT_ORDERS as readonly string[]).includes(value);
}

function readSort(entity: MetaObject, raw: unknown): [string, SortOrder] | undefined {
  if (raw === undefined) return undefined;
  const allowed = sortableFields(entity);
  const [name = "", suppliedOrder] = typeof raw === "string" ? raw.split(":") : [];
  const field = allowed.get(name);
  // Caller's order, else the field's declared default, else ascending.
  const order = (suppliedOrder ?? String(field?.attr(FIELD_ATTR_SORTABLE_DEFAULT_ORDER) ?? "asc")).toLowerCase();
  if (field === undefined || !isSortOrder(order)) {
    throw new ListQueryError(ERROR_INVALID_SORT, `"${String(raw)}" is not a sort this list accepts.`, {
      field: name, expected: SORT_EXPECTED, allowed: [...allowed.keys()],
    });
  }
  return [name, order];
}

function readPageBound(query: Readonly<Record<string, unknown>>, param: "limit" | "offset"): number | undefined {
  const raw = query[param];
  if (raw === undefined) return undefined;
  const text = typeof raw === "string" ? raw : String(raw);
  const n = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(n)) {
    throw new ListQueryError(ERROR_INVALID_PAGE_BOUND, `?${param}= must be ${PAGE_BOUND_EXPECTED}, got "${text}".`, {
      param, value: text, expected: PAGE_BOUND_EXPECTED,
    });
  }
  return n;
}

/** The limit a list applies: the caller's, else the default; above the maximum is refused. */
function pageLimit(limit: number | undefined, pageSize: ApiPagination | undefined): number | undefined {
  if (pageSize === undefined) return limit;
  if (limit === undefined) return pageSize.defaultLimit;
  if (limit > pageSize.maxLimit) {
    throw new ListQueryError(ERROR_LIMIT_TOO_LARGE, `?limit= must be at most ${pageSize.maxLimit}, got ${limit}.`, {
      maxLimit: pageSize.maxLimit,
    });
  }
  return limit;
}

/**
 * Read a parsed query string (`qs.parse`) as a list request on `entity`, or throw the
 * `ListQueryError` the route answers as a 400.
 */
export function readListQuery(
  entity: MetaObject,
  query: Readonly<Record<string, unknown>>,
  pageSize: ApiPagination | undefined,
): ListQuery {
  const opts: QueryOpts = {};
  const limit = pageLimit(readPageBound(query, "limit"), pageSize);
  const offset = readPageBound(query, "offset");
  if (limit !== undefined) opts.limit = limit;
  if (offset !== undefined) opts.offset = offset;
  // The caller's sort, then the key. Without the key, rows that tie on the sort field (or
  // every row, when there is no sort) come back in whatever order the database likes, and
  // a row can show on two pages while another shows on none.
  const sort = readSort(entity, query["sort"]);
  const orderBy: [string, SortOrder][] = sort === undefined ? [] : [sort];
  for (const key of entity.primaryIdentity()?.fields ?? []) {
    if (key !== sort?.[0]) orderBy.push([key, "asc"]);
  }
  if (orderBy.length > 0) opts.orderBy = orderBy;
  const withCount = query["withCount"] === "1" || query["withCount"] === true;
  return { filter: readFilter(entity, query["filter"]), opts, withCount };
}
