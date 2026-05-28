// Hono read-only mount — projection (view-backed) entities. GET list +
// GET :id only. POST/PATCH/DELETE return 405. Mirrors the drizzle-fastify
// equivalent so the cross-port API contract holds for projection endpoints.

import type { Hono } from "hono";
import { sql, eq, and, count } from "drizzle-orm";
import qs from "qs";
import { parseFilterParams, FilterParseError } from "../drizzle-fastify/filter-parser.js";
import type {
  FilterAllowlist,
  SortAllowlist,
} from "../drizzle-fastify/filter-allowlist.js";
import { isTruthyFlag } from "../drizzle-fastify/util.js";

// biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch over user-supplied views
type AnyView = any;
// biome-ignore lint/suspicious/noExplicitAny: generic Hono app
type AnyHono = Hono<any, any, any>;

/**
 * Drizzle v0.45 stores view config under this well-known Symbol. Mirrors
 * the same workaround the Fastify mount uses — accessing `view._` on a
 * proxy-wrapped view throws.
 */
const VIEW_BASE_CONFIG = Symbol.for("drizzle:ViewBaseConfig");

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

function getViewConfig(view: AnyView): Record<string, unknown> | undefined {
  try {
    const cfg = (view as Record<symbol, unknown>)[VIEW_BASE_CONFIG];
    if (cfg && typeof cfg === "object") return cfg as Record<string, unknown>;
  } catch {
    // ignore — proxy handler may throw on unexpected shapes
  }
  return undefined;
}

function resolveViewName(view: AnyView): string | undefined {
  const cfg = getViewConfig(view);
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
  const cfg = getViewConfig(view);
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

export function mountReadOnlyCrudRoutes(opts: MountReadOnlyOptions): void {
  const { app, path, db, view, filterAllowlist, sortAllowlist, dialect } = opts;
  const idCol = opts.idColumn ?? "id";

  const viewName = resolveViewName(view);
  const useRawSql = isEmptyColumnView(view) && !!viewName;

  // ── List ──────────────────────────────────────────────────────────────────
  app.get(path, async (c) => {
    try {
      if (useRawSql) {
        const url = c.req.url;
        const qIdx = url.indexOf("?");
        const queryString = qIdx >= 0 ? url.slice(qIdx + 1) : "";
        const parsed = qs.parse(queryString) as Record<string, unknown>;
        const limitVal = Math.min(
          1000,
          Math.max(1, Number(typeof parsed["limit"] === "string" ? parsed["limit"] : 1000)),
        );
        const offsetVal = Math.max(
          0,
          Number(typeof parsed["offset"] === "string" ? parsed["offset"] : 0),
        );
        const withCount = isTruthyFlag(parsed["withCount"]);
        // biome-ignore lint/suspicious/noExplicitAny: dynamic raw result
        const rows = (await db.all(sql.raw(`SELECT * FROM "${viewName}" LIMIT ${limitVal} OFFSET ${offsetVal}`))) as any[];
        const camelRows = rows.map((r: Record<string, unknown>) => camelizeRow(r));
        if (!withCount) return c.json(camelRows);
        // biome-ignore lint/suspicious/noExplicitAny: dynamic raw result
        const countRows = (await db.all(sql.raw(`SELECT COUNT(*) AS c FROM "${viewName}"`))) as any[];
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
      const rows = await q.all();

      if (!withCount) return c.json(rows);

      let cq = db.select({ c: count() }).from(view);
      if (combinedWhere) cq = cq.where(combinedWhere);
      const countRow = (await cq.all())[0] as { c: number } | undefined;
      const total = countRow?.c ?? 0;
      return c.json({ rows, total });
    } catch (err) {
      if (err instanceof FilterParseError) {
        return c.json({ error: err.code, message: err.message }, 400);
      }
      throw err;
    }
  });

  // ── Get by ID ─────────────────────────────────────────────────────────────
  app.get(`${path}/:id`, async (c) => {
    const id = c.req.param("id") ?? "";
    if (useRawSql) {
      const numericId = Number(id);
      if (!Number.isFinite(numericId)) {
        return c.json({ error: "invalid_id" }, 400);
      }
      // biome-ignore lint/suspicious/noExplicitAny: dynamic raw result
      const rows = (await db.all(sql.raw(`SELECT * FROM "${viewName}" WHERE "${idCol}" = ${numericId} LIMIT 1`))) as any[];
      const row = rows[0] ? camelizeRow(rows[0]) : undefined;
      return row ? c.json(row) : c.json({ error: "not_found" }, 404);
    }
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle view column ref
    const colRef = (view as any)[idCol];
    const row = await db
      .select()
      .from(view)
      .where(colRef !== undefined ? eq(colRef, Number(id)) : undefined)
      .get();
    return row ? c.json(row) : c.json({ error: "not_found" }, 404);
  });

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
  // biome-ignore lint/suspicious/noExplicitAny: cross-version Hono typing
  app.delete(`${path}/:id`, reject as any);
}
