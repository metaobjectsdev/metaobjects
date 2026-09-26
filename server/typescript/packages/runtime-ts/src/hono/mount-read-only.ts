// Hono read-only mount — projection (view-backed) entities. GET list +
// GET :id only. POST/PATCH/PUT/DELETE return 405. Mirrors the drizzle-fastify
// equivalent so the cross-port API contract holds for projection endpoints.

import type { Hono } from "hono";
import { sql, eq, and, count } from "drizzle-orm";
import qs from "qs";
import { parseFilterParams, parsePageBound, RAW_VIEW_MAX_LIMIT, FilterParseError } from "../drizzle-fastify/filter-parser.js";
import type {
  FilterAllowlist,
  SortAllowlist,
} from "../drizzle-fastify/filter-allowlist.js";
import { isTruthyFlag, coerceIdForColumn, rawIdLiteral, contractErrorCode, viewBaseConfig } from "../drizzle-fastify/util.js";
import { timestampWire } from "../timestamp-wire.js";
// An unexpected error on a mounted route answers `500 { error: "internal" }`.
import { guardRoute } from "./route-guard.js";

// biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch over user-supplied views
type AnyView = any;
// biome-ignore lint/suspicious/noExplicitAny: generic Hono app
type AnyHono = Hono<any, any, any>;

export interface MountReadOnlyOptions {
  readonly app: AnyHono;
  readonly path: string;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic Drizzle client
  readonly db: any;
  readonly view: AnyView;
  readonly filterAllowlist: FilterAllowlist;
  readonly sortAllowlist: SortAllowlist;
  readonly dialect: "postgres" | "sqlite";
  /** Override default ID column name (defaults to "id"). */
  readonly idColumn?: string;
}

function resolveViewName(view: AnyView): string | undefined {
  const cfg = viewBaseConfig(view);
  if (cfg) {
    if (typeof cfg["name"] === "string") return cfg["name"] as string;
  }
  const v = view as Record<string, unknown>;
  return (
    (typeof v["__tableName"] === "string" ? v["__tableName"] as string : undefined) ??
    (typeof v["_name"] === "string" ? v["_name"] as string : undefined)
  );
}

function isEmptyColumnView(view: AnyView): boolean {
  const cfg = viewBaseConfig(view);
  if (cfg) {
    const fields = cfg["selectedFields"] as Record<string, unknown> | undefined;
    return fields !== undefined && Object.keys(fields).length === 0;
  }
  return false;
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function camelizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[snakeToCamel(k)] = v;
  }
  return out;
}

/**
 * Execute a raw SQL read and return its rows, on EITHER dialect.
 *
 * There is no shared method: drizzle's `BaseSQLiteDatabase` has `.all()` and no
 * `.execute()`; `PgDatabase` has `.execute()` and no `.all()` at all (verified
 * against drizzle-orm's own `sqlite-core/db.d.ts` and `pg-core/db.d.ts`). So this
 * must DISPATCH — unlike the #286 sites, where the query builder is thenable on
 * both dialects and simply awaiting it was enough.
 *
 * That difference is exactly why the #286 sweep missed these. It hunted `.all()`
 * on a query BUILDER; these are `.all()` on the top-level `db` HANDLE — the libsql
 * raw-exec API, which node-postgres does not implement. BOTH read-only mounts
 * carried three each, so the Fastify adapter was broken here too despite being the
 * correct reference for the builder shape. Reported by an adopting project's code
 * review of the 0.21.4 upgrade.
 *
 * Reachable whenever `useRawSql` is true — an opaque `@sql` view body (the ADR-0043
 * escape hatch), where the view declares no columns for the query builder to select.
 *
 * The two Postgres drivers disagree on the result shape (node-postgres returns a
 * QueryResult with `.rows`, postgres-js returns the array itself), so both are
 * handled rather than betting on one.
 */
// biome-ignore lint/suspicious/noExplicitAny: driver handle is consumer-provided
async function rawRows(db: any, dialect: string | undefined, query: unknown): Promise<Record<string, unknown>[]> {
  if (dialect === "postgres") {
    const res: unknown = await db.execute(query);
    if (Array.isArray(res)) return res as Record<string, unknown>[];
    return (res as { rows?: Record<string, unknown>[] } | null)?.rows ?? [];
  }
  return (await db.all(query)) as Record<string, unknown>[];
}

export function mountReadOnlyCrudRoutes(opts: MountReadOnlyOptions): void {
  const { app, path, db, view, filterAllowlist, sortAllowlist, dialect } = opts;
  const idCol = opts.idColumn ?? "id";

  const viewName = resolveViewName(view);
  const useRawSql = isEmptyColumnView(view) && !!viewName;
  // The raw-SQL branch has no declared columns, so nothing names a timestamp there.
  const toWire = timestampWire(view);

  // ── List ──────────────────────────────────────────────────────────────────
  app.get(path, guardRoute(async (c) => {
    try {
      if (useRawSql) {
        const url = c.req.url;
        const qIdx = url.indexOf("?");
        const queryString = qIdx >= 0 ? url.slice(qIdx + 1) : "";
        const parsed = qs.parse(queryString) as Record<string, unknown>;
        // A bound that is not an integer in range is a 400, not silently clamped.
        const limitVal = parsePageBound(parsed, "limit", RAW_VIEW_MAX_LIMIT) ?? RAW_VIEW_MAX_LIMIT;
        const offsetVal = parsePageBound(parsed, "offset") ?? 0;
        const withCount = isTruthyFlag(parsed["withCount"]);
        // biome-ignore lint/suspicious/noExplicitAny: dynamic raw result
        const rows = (await rawRows(db, dialect, sql.raw(`SELECT * FROM "${viewName}" LIMIT ${limitVal} OFFSET ${offsetVal}`))) as any[];
        const camelRows = rows.map((r: Record<string, unknown>) => camelizeRow(r));
        if (!withCount) return c.json(camelRows);
        // biome-ignore lint/suspicious/noExplicitAny: dynamic raw result
        const countRows = (await rawRows(db, dialect, sql.raw(`SELECT COUNT(*) AS c FROM "${viewName}"`))) as any[];
        const total: number = Number(countRows[0]?.c ?? 0);
        return c.json({ rows: camelRows, total });
      }

      const url = c.req.url;
      const qIdx = url.indexOf("?");
      const queryString = qIdx >= 0 ? url.slice(qIdx + 1) : "";
      const parsed = qs.parse(queryString) as Record<string, unknown>;
      const withCount = isTruthyFlag(parsed["withCount"]);
      const result = parseFilterParams({
        query: parsed,
        table: view,
        allowlist: filterAllowlist,
        sortAllowlist,
        dialect,
      });
      const combinedWhere = result.where && result.searchWhere
        ? and(result.where, result.searchWhere)
        : (result.where ?? result.searchWhere);
      let q = db.select().from(view);
      if (combinedWhere) q = q.where(combinedWhere);
      if (result.orderBy) q = q.orderBy(...result.orderBy);
      if (result.limit !== undefined) q = q.limit(result.limit);
      if (result.offset !== undefined) q = q.offset(result.offset);
      // Await the query directly rather than calling `.all()`: the drizzle-orm
      // node-postgres builder is thenable but has no `.all()` (a libsql /
      // better-sqlite3-only API). Awaiting works on BOTH dialects — this is what
      // makes the Hono helpers genuinely Postgres-capable, matching the Fastify
      // adapter, which carried this fix while Hono did not (#286).
      const rows = (await q as unknown[]).map(toWire);

      if (!withCount) return c.json(rows);

      let cq = db.select({ c: count() }).from(view);
      if (combinedWhere) cq = cq.where(combinedWhere);
      const countRow = (await cq)[0] as { c: number } | undefined;
      const total = countRow?.c ?? 0;
      return c.json({ rows, total });
    } catch (err) {
      if (err instanceof FilterParseError) {
        // Wire code + the details (so the cross-port-required `field` is present),
        // matching the Fastify projection mount.
        return c.json({ error: contractErrorCode(err.code), message: err.message, ...(err.details ?? {}) }, 400);
      }
      throw err;
    }
  }));

  // ── Get by ID ─────────────────────────────────────────────────────────────
  app.get(`${path}/:id`, guardRoute(async (c) => {
    const id = c.req.param("id") ?? "";
    if (useRawSql) {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic raw result
      const rows = (await rawRows(db, dialect, sql.raw(`SELECT * FROM "${viewName}" WHERE "${idCol}" = ${rawIdLiteral(id)} LIMIT 1`))) as any[];
      const row = rows[0] ? camelizeRow(rows[0]) : undefined;
      return row ? c.json(row) : c.json({ error: "not_found" }, 404);
    }
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle view column ref
    const colRef = (view as any)[idCol];
    // Compare against the PK's real type — a uuid/text key must NOT go through Number().
    const idValue = coerceIdForColumn(colRef, id);
    if (idValue === undefined) {
      return c.json({ error: "invalid_id" }, 400);
    }
    // `.get()` is likewise libsql/better-sqlite3-only; `.limit(1)` + await + [0]
    // is the portable single-row read (#286).
    const rows = await db
      .select()
      .from(view)
      .where(colRef !== undefined ? eq(colRef, idValue) : undefined)
      .limit(1);
    const row = (rows as unknown[])[0];
    return row ? c.json(toWire(row)) : c.json({ error: "not_found" }, 404);
  }));

  // ── Mutations explicitly rejected (405) ───────────────────────────────────
  const reject = (c: { req: { method: string }; json: (body: unknown, status: number) => unknown }) =>
    c.json(
      { error: "method_not_allowed", message: `${c.req.method} is not supported on a projection (read-only).` },
      405,
    );
  // biome-ignore lint/suspicious/noExplicitAny: cross-version Hono typing
  app.post(path, reject as any);
  // biome-ignore lint/suspicious/noExplicitAny: cross-version Hono typing
  app.patch(`${path}/:id`, reject as any);
  // PUT too — the writable mount serves it, so a projection must reject it rather
  // than 404, which would deny a resource that answers GET on the same path.
  // biome-ignore lint/suspicious/noExplicitAny: cross-version Hono typing
  app.put(`${path}/:id`, reject as any);
  // biome-ignore lint/suspicious/noExplicitAny: cross-version Hono typing
  app.delete(`${path}/:id`, reject as any);
}
