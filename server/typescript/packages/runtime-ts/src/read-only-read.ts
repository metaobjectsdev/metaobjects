// read-only-read.ts — how a read-only object (an `object.projection`, a served `object.report`) is
// read: the list page and the row by key, with the filter, sort and page of the REST contract, a
// report's row cap and its export. Framework-neutral: the Fastify mount (`mountReadOnlyCrudRoutes`)
// and the generated service (ADR-0067 layer 4) both call it, so the flat routes and the service
// read a view the same way and answer its refusals with the same codes.
//
// A refusal is thrown: `FilterParseError` (a query the allowlists refuse), `ReportTooLargeError`
// (more rows than a report answers), `ReportExportError` (an export the spec refuses), and
// `InvalidIdError` (an id that is no key of the view's key column).

import { sql, eq, and, count } from "drizzle-orm";
import { quoteIdent, type SqlDialect } from "./sql-dialect.js";
import {
  parseFilterParams, parsePageBound, pageLimit, parseReportPage, RAW_VIEW_MAX_LIMIT, REPORT_MAX_ROWS, ReportTooLargeError, type PageSize,
} from "./drizzle-fastify/filter-parser.js";
import {
  assertExportWithinCap, exportWithCountError, isExportCountFlag, parseExportPage, readExportFormat, type ExportFormat, type ReportExportSpec,
} from "./drizzle-fastify/report-export.js";
import type { FilterAllowlist, SortAllowlist } from "./drizzle-fastify/filter-allowlist.js";
import { isTruthyFlag, coerceIdForColumn, rawIdLiteral, viewBaseConfig } from "./drizzle-fastify/util.js";

// biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch over user-supplied views and driver handles
type Any = any;

/** An id that is no key of the column it addresses: answered `400 { "error": "invalid_id" }`. */
export class InvalidIdError extends Error {
  constructor() {
    super("invalid_id");
    this.name = "InvalidIdError";
  }
}

/** How a read-only object is read. */
export interface ReadOnlySpec {
  readonly filterAllowlist: FilterAllowlist;
  readonly sortAllowlist: SortAllowlist;
  readonly dialect: SqlDialect;
  /**
   * The column a row is addressed by: the KEY of that column in the Drizzle view (the field name).
   * Default "id". For a view declared with no columns (the raw-SQL path) it is the physical column
   * name instead. A view with no column under this key has no addressable row.
   */
  readonly idColumn?: string;
  /** A served report: it answers every row up to `reportMaxRows` and refuses above it. */
  readonly report?: boolean;
  /** A report's row cap. Default 10000, the same in every port. */
  readonly reportMaxRows?: number;
  /** A projection's page size (`api.pagination`); ignored for a report and a raw view. */
  readonly pagination?: PageSize;
  /** A report's export (`report-export` wired): `?format=` answers the list in that shape. */
  readonly export?: ReportExportSpec;
}

/** A page of a read-only object: its rows, the count when asked (`withCount`), and the export format when one was asked. */
export interface ReadOnlyPage<T = Record<string, unknown>> {
  readonly rows: T[];
  readonly total?: number;
  /** Set when the query asked for an export (`?format=`): the transport renders the rows in it. */
  readonly format?: ExportFormat;
}

function resolveViewName(view: Any): string | undefined {
  const cfg = viewBaseConfig(view);
  if (cfg && typeof cfg["name"] === "string") return cfg["name"] as string;
  const v = view as Record<string, unknown>;
  return (
    (typeof v["__tableName"] === "string" ? (v["__tableName"] as string) : undefined) ??
    (typeof v["_name"] === "string" ? (v["_name"] as string) : undefined)
  );
}

/**
 * Whether a Drizzle view was declared with `.existing()` and an empty column schema (`{}`), for
 * which `db.select().from(view)` would write `SELECT  FROM ...`: such a view is read with raw SQL.
 */
function isEmptyColumnView(view: Any): boolean {
  const cfg = viewBaseConfig(view);
  if (cfg) {
    const fields = cfg["selectedFields"] as Record<string, unknown> | undefined;
    return fields !== undefined && Object.keys(fields).length === 0;
  }
  return false;
}

/** The view's name when it is read with raw SQL (an empty-column `.existing()` view), else undefined. */
export function rawViewName(view: Any): string | undefined {
  const name = resolveViewName(view);
  return isEmptyColumnView(view) && !!name ? name : undefined;
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Normalise a raw SQL result row's keys from snake_case to camelCase. */
function camelizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[snakeToCamel(k)] = v;
  return out;
}

/**
 * Execute a raw SQL read and return its rows, on every dialect: Drizzle's SQLite database has
 * `.all()` and no `.execute()`, Postgres `.execute()` (node-postgres answering `.rows`, postgres-js
 * the array), MySQL `.execute()` answering `[rows, fields]`.
 */
async function rawRows(db: Any, dialect: string | undefined, query: unknown): Promise<Record<string, unknown>[]> {
  if (dialect === "postgres") {
    const res: unknown = await db.execute(query);
    if (Array.isArray(res)) return res as Record<string, unknown>[];
    return (res as { rows?: Record<string, unknown>[] } | null)?.rows ?? [];
  }
  if (dialect === "mysql") {
    const [rows] = (await db.execute(query)) as [Record<string, unknown>[], unknown];
    return rows;
  }
  return (await db.all(query)) as Record<string, unknown>[];
}

/**
 * A page of `view`: the filter, search, sort and page of `query` (the bracketed tree a query
 * string parses to), checked against the allowlists. A report answers every row up to its cap and
 * refuses above it; with an export spec, `?format=` selects an export, capped by `export.maxRows`.
 */
export async function readOnlyList(db: Any, view: Any, query: Record<string, unknown>, spec: ReadOnlySpec): Promise<ReadOnlyPage> {
  const isReport = spec.report === true;
  const reportMaxRows = spec.reportMaxRows ?? REPORT_MAX_ROWS;
  const exportSpec = isReport ? spec.export : undefined;
  const withCount = isTruthyFlag(query["withCount"]);
  const viewName = rawViewName(view);

  if (viewName !== undefined) {
    // No declared columns, so no filter or sort: a page of the whole view.
    const reportPage = isReport ? parseReportPage(query, reportMaxRows) : undefined;
    const limit = reportPage?.limit ?? parsePageBound(query, "limit", RAW_VIEW_MAX_LIMIT) ?? RAW_VIEW_MAX_LIMIT;
    const offset = reportPage?.offset ?? parsePageBound(query, "offset") ?? 0;
    const rows = await rawRows(db, spec.dialect, sql.raw(`SELECT * FROM ${quoteIdent(spec.dialect, viewName)} LIMIT ${limit} OFFSET ${offset}`));
    if (reportPage?.unbounded && rows.length > reportMaxRows) throw new ReportTooLargeError(reportMaxRows);
    const camelRows = rows.map(camelizeRow);
    if (!withCount) return { rows: camelRows };
    const countRows = await rawRows(db, spec.dialect, sql.raw(`SELECT COUNT(*) AS c FROM ${quoteIdent(spec.dialect, viewName)}`));
    return { rows: camelRows, total: Number(countRows[0]?.["c"] ?? 0) };
  }

  // Export mode: the selector is validated before any query runs, and the export cap governs.
  const format = exportSpec ? readExportFormat(query, exportSpec) : undefined;
  if (format !== undefined && format !== "json" && isExportCountFlag(query["withCount"])) throw exportWithCountError();
  const reportPage = exportSpec && format !== undefined
    ? parseExportPage(query, exportSpec.maxRows)
    : isReport ? parseReportPage(query, reportMaxRows) : undefined;
  const parsed = parseFilterParams({ query, table: view, allowlist: spec.filterAllowlist, sortAllowlist: spec.sortAllowlist, dialect: spec.dialect });
  const where = parsed.where && parsed.searchWhere ? and(parsed.where, parsed.searchWhere) : (parsed.where ?? parsed.searchWhere);
  let q = db.select().from(view);
  if (where) q = q.where(where);
  if (parsed.orderBy) q = q.orderBy(...parsed.orderBy);
  // A report fetches one row past the cap when no limit was sent, to tell exactly the cap apart
  // from more than the cap before any body is written.
  const limit = reportPage?.limit ?? pageLimit(parsed.limit, spec.pagination);
  const offset = reportPage?.offset ?? parsed.offset;
  if (limit !== undefined) q = q.limit(limit);
  if (offset !== undefined) q = q.offset(offset);
  const rows = (await q) as Record<string, unknown>[];
  if (exportSpec && format !== undefined && reportPage) assertExportWithinCap(rows.length, reportPage, exportSpec.maxRows);
  else if (reportPage?.unbounded && rows.length > reportMaxRows) throw new ReportTooLargeError(reportMaxRows);

  let total: number | undefined;
  if (withCount) {
    let cq = db.select({ c: count() }).from(view);
    if (where) cq = cq.where(where);
    total = ((await cq)[0] as { c: number } | undefined)?.c ?? 0;
  }
  return { rows, ...(total === undefined ? {} : { total }), ...(format === undefined ? {} : { format }) };
}

/**
 * The row of `view` that `id` names, or undefined when there is none (or when the view has no
 * column under `spec.idColumn`, so no row is addressable). Throws `InvalidIdError` for an id that
 * is no key of that column.
 */
export async function readOnlyGet(db: Any, view: Any, id: string | number, spec: Pick<ReadOnlySpec, "dialect" | "idColumn">): Promise<Record<string, unknown> | undefined> {
  const idCol = spec.idColumn ?? "id";
  const viewName = rawViewName(view);
  if (viewName !== undefined) {
    const literal = rawIdLiteral(String(id));
    if (literal === undefined) throw new InvalidIdError();
    const rows = await rawRows(db, spec.dialect, sql.raw(`SELECT * FROM ${quoteIdent(spec.dialect, viewName)} WHERE ${quoteIdent(spec.dialect, idCol)} = ${literal} LIMIT 1`));
    return rows[0] ? camelizeRow(rows[0]) : undefined;
  }
  const colRef = view[idCol];
  // No column under `idColumn`: a query with no WHERE would answer the view's first row.
  if (colRef === undefined) return undefined;
  // Compare against the key's real type: a uuid or text key must not go through Number().
  const value = coerceIdForColumn(colRef, String(id));
  if (value === undefined) throw new InvalidIdError();
  const rows = (await db.select().from(view).where(eq(colRef, value)).limit(1)) as Record<string, unknown>[];
  return rows[0];
}
