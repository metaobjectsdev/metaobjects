// Drizzle-direct Hono adapter — Hono parallel of the drizzle-fastify mount
// helpers. Aimed at Workers / Bun / Node consumers running Hono on top of
// a Drizzle instance.
//
// Wire-format-identical to the Fastify flavor:
//
//   GET    {path}      list with ?filter / ?sort / ?limit / ?offset / ?withCount=1
//   GET    {path}/:id  findById, 404 if missing
//   POST   {path}      create, 400 on Zod validation error, 201 on success
//   PATCH  {path}/:id  update (default), 400 / 404 envelopes
//   PUT    {path}/:id  update (when updateMethod === "put")
//   DELETE {path}/:id  delete, 204 on success, 404 if missing
//
// Filter / sort / withCount semantics are shared with drizzle-fastify via
// parseFilterParams and parseHonoFilterParams (qs.parse on the raw URL),
// so the two flavors emit byte-identical wire responses for the cross-port
// API-contract corpus.

import type { Hono, Context } from "hono";
import type { ZodTypeAny } from "zod";
import { eq, count, and } from "drizzle-orm";
import qs from "qs";
import {
  parseFilterParams,
  FilterParseError,
  type ParseFilterResult,
} from "../drizzle-fastify/filter-parser.js";
import type {
  FilterAllowlist,
  SortAllowlist,
} from "../drizzle-fastify/filter-allowlist.js";
export type {
  FilterAllowlist,
  SortAllowlist,
} from "../drizzle-fastify/filter-allowlist.js";
import { isTruthyFlag, coerceIdForColumn } from "../drizzle-fastify/util.js";
// Back-compat re-export — the unsafe local copy was consolidated onto the one
// shared (deprecated) helper so the three adapters can't silently diverge.
export { parseId } from "../drizzle-fastify/util.js";

// ---------------------------------------------------------------------------
// Loose types — we don't bind to a specific Drizzle backend so the helper
// works across libsql / better-sqlite3 / D1 / pg / etc.
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch over user's Drizzle instance
type AnyDrizzle = any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch over user's Drizzle table
type AnyTable = any;
// biome-ignore lint/suspicious/noExplicitAny: generic Hono app — bindings/variables are the consumer's
type AnyHono = Hono<any, any, any>;

export type CrudVerb = "list" | "get" | "create" | "update" | "delete";

export interface CrudRoutesOptions {
  /** Hono app instance. Bindings type is the consumer's — kept generic here. */
  app: AnyHono;
  /** REST resource path, e.g. "/subscribers". */
  path: string;
  /** User's Drizzle instance. */
  db: AnyDrizzle;
  /** Drizzle table const. Must expose an `id` column. */
  table: AnyTable;
  /** Zod schema for create payloads (typically `<Entity>InsertSchema`). */
  insertSchema: ZodTypeAny;
  /** Zod schema for update payloads (typically `<Entity>UpdateSchema`). */
  updateSchema: ZodTypeAny;
  /** Limit which verbs are mounted. Defaults to all five. */
  expose?: readonly CrudVerb[];
  /**
   * HTTP method for the update verb. Defaults to "patch". Set to "put" to
   * preserve a legacy API contract that already uses PUT for updates.
   */
  updateMethod?: "patch" | "put";
  filterAllowlist?: FilterAllowlist;
  sortAllowlist?:   SortAllowlist;
  /** Dialect — required if filterAllowlist or sortAllowlist is set (for like/ilike dispatch). */
  dialect?: "sqlite" | "postgres";
}

const ALL_VERBS: readonly CrudVerb[] = ["list", "get", "create", "update", "delete"];

export function mountCrudRoutes(opts: CrudRoutesOptions): void {
  const verbs = new Set<CrudVerb>(opts.expose ?? ALL_VERBS);
  if (verbs.has("list"))   mountListRoute(opts);
  if (verbs.has("get"))    mountGetRoute(opts);
  if (verbs.has("create")) mountCreateRoute(opts);
  if (verbs.has("update")) mountUpdateRoute(opts);
  if (verbs.has("delete")) mountDeleteRoute(opts);
}

type VerbOptions = Omit<CrudRoutesOptions, "expose">;

// ---------------------------------------------------------------------------
// Hono-flavored qs.parse — analogue of Fastify's qs.parse(req.raw.url ...).
//
// Hono exposes the raw URL via c.req.url; we strip the prefix and feed the
// raw query string to qs so the bracketed filter notation (filter[a][eq]=...)
// is recognised. The plain c.req.query() helper drops bracket structure, so
// it can't replace this.
// ---------------------------------------------------------------------------

export function parseHonoFilterParams(c: Context): Record<string, unknown> {
  const url = c.req.url;
  const qIdx = url.indexOf("?");
  const queryString = qIdx >= 0 ? url.slice(qIdx + 1) : "";
  return qs.parse(queryString) as Record<string, unknown>;
}

export function mountListRoute(opts: VerbOptions): void {
  opts.app.get(opts.path, async (c) => {
    try {
      let q = opts.db.select().from(opts.table).$dynamic();
      const qsParsed = parseHonoFilterParams(c);
      const withCount = isTruthyFlag(qsParsed.withCount);

      let where: ParseFilterResult["where"];
      if (opts.filterAllowlist && opts.sortAllowlist) {
        const parsed = parseFilterParams({
          query: qsParsed,
          table: opts.table,
          allowlist: opts.filterAllowlist,
          sortAllowlist: opts.sortAllowlist,
          dialect: opts.dialect ?? "sqlite",
        });
        const combinedWhere = parsed.where && parsed.searchWhere
          ? and(parsed.where, parsed.searchWhere)
          : (parsed.where ?? parsed.searchWhere);
        if (combinedWhere) { q = q.where(combinedWhere); where = combinedWhere; }
        if (parsed.orderBy) q = q.orderBy(...parsed.orderBy);
        if (parsed.limit  !== undefined) q = q.limit(parsed.limit);
        if (parsed.offset !== undefined) q = q.offset(parsed.offset);
      } else {
        // No allowlists configured. Only limit/offset.
        const flat = c.req.query();
        if (flat.limit  !== undefined) q = q.limit(Number(flat.limit));
        if (flat.offset !== undefined) q = q.offset(Number(flat.offset));
      }

      const rows = await q.all();

      if (!withCount) return c.json(rows);

      // Count query: same WHERE, no limit/offset/orderBy.
      let cq = opts.db.select({ c: count() }).from(opts.table).$dynamic();
      if (where) cq = cq.where(where);
      const countRow = (await cq.all())[0] as { c: number } | undefined;
      const total = countRow?.c ?? 0;
      return c.json({ rows, total });
    } catch (err) {
      if (err instanceof FilterParseError) {
        return c.json({ error: err.code, ...(err.details ?? {}) }, 400);
      }
      throw err;
    }
  });
}

export function mountGetRoute(opts: VerbOptions): void {
  opts.app.get(`${opts.path}/:id`, async (c) => {
    const id = c.req.param("id") ?? "";
    // Compare against the PK's real type — a numeric-LOOKING id on a TEXT pk
    // must stay a string ('0123' ≠ '123'), or affinity matches the WRONG row.
    const idValue = coerceIdForColumn(opts.table.id, id);
    if (idValue === undefined) return c.json({ error: "invalid_id" }, 400);
    const row = await opts.db
      .select()
      .from(opts.table)
      .where(eq(opts.table.id, idValue))
      .get();
    return row ? c.json(row) : c.json({ error: "not_found" }, 404);
  });
}

export function mountCreateRoute(opts: VerbOptions): void {
  opts.app.post(opts.path, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const parsed = opts.insertSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "validation", issues: parsed.error.issues }, 400);
    }
    const result = await opts.db.insert(opts.table).values(parsed.data).returning();
    const row = (result as unknown[])[0];
    return c.json(row, 201);
  });
}

export function mountUpdateRoute(opts: VerbOptions): void {
  const handler = async (c: Context) => {
    const id = c.req.param("id") ?? "";
    const body = await c.req.json().catch(() => undefined);
    const parsed = opts.updateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "validation", issues: parsed.error.issues }, 400);
    }
    // Compare against the PK's real type (see mountGetRoute) — a numeric-
    // LOOKING id on a TEXT pk would otherwise UPDATE the wrong row.
    const idValue = coerceIdForColumn(opts.table.id, id);
    if (idValue === undefined) return c.json({ error: "invalid_id" }, 400);
    const result = await opts.db
      .update(opts.table)
      .set(parsed.data)
      .where(eq(opts.table.id, idValue))
      .returning();
    const row = (result as unknown[])[0];
    return row ? c.json(row) : c.json({ error: "not_found" }, 404);
  };
  const path = `${opts.path}/:id`;
  if (opts.updateMethod === "put") {
    opts.app.put(path, handler);
  } else {
    opts.app.patch(path, handler);
  }
}

export function mountDeleteRoute(opts: VerbOptions): void {
  opts.app.delete(`${opts.path}/:id`, async (c) => {
    const id = c.req.param("id") ?? "";
    // Compare against the PK's real type (see mountGetRoute) — a numeric-
    // LOOKING id on a TEXT pk would otherwise DELETE the wrong row (data loss).
    const idValue = coerceIdForColumn(opts.table.id, id);
    if (idValue === undefined) return c.json({ error: "invalid_id" }, 400);
    const result = await opts.db
      .delete(opts.table)
      .where(eq(opts.table.id, idValue));
    const affected = extractRowCount(result);
    if (affected > 0) {
      // 204 No Content — body must be empty.
      return c.body(null, 204);
    }
    return c.json({ error: "not_found" }, 404);
  });
}

function extractRowCount(result: unknown): number {
  if (typeof result === "number") return result;
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === "object") {
    const obj = result as { rowsAffected?: number | bigint; rowCount?: number; changes?: number };
    if (typeof obj.rowsAffected === "number") return obj.rowsAffected;
    if (typeof obj.rowsAffected === "bigint") return Number(obj.rowsAffected);
    if (typeof obj.rowCount === "number") return obj.rowCount;
    // bun:sqlite / better-sqlite3 run() result shape.
    if (typeof obj.changes === "number") return obj.changes;
  }
  return 0;
}

export { mountReadOnlyCrudRoutes, type MountReadOnlyOptions } from "./mount-read-only.js";
