// Drizzle-direct Fastify adapter — replaces the ObjectManager-flavored
// mountCrudRoutes for consumers that already use Drizzle directly.
//
// Why: most TS apps stay on Drizzle for SQL queries. Routing CRUD through
// ObjectManager + a Drizzle driver was indirection for no real win — generated
// routes can just call Drizzle directly and stay self-evident as Drizzle code.
//
// What this gives you: one helper, same surface as before, but the runtime
// dependency is Drizzle + Zod, not ObjectManager.
//
//   GET    {path}      list with ?limit / ?offset
//   GET    {path}/:id  findById, 404 if missing
//   POST   {path}      create, 400 on Zod validation error
//   PATCH  {path}/:id  update, 400 on validation, 404 if missing
//   DELETE {path}/:id  delete, 204 on success, 404 if missing

import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import type { ZodTypeAny } from "zod";
import { eq, count, and, asc } from "drizzle-orm";
import qs from "qs";
import type { FilterAllowlist, SortAllowlist } from "./filter-allowlist.js";
export type { FilterAllowlist, SortAllowlist } from "./filter-allowlist.js";
import { parseFilterParams, FilterParseError } from "./filter-parser.js";
import { isTruthyFlag, contractErrorCode, coerceIdForColumn } from "./util.js";
export { isTruthyFlag, contractErrorCode, parseId, coerceIdForColumn } from "./util.js";

// ---------------------------------------------------------------------------
// Loose types — we don't bind to a specific Drizzle backend so the helper
// works across libsql / better-sqlite3 / pg / etc.
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch over user's Drizzle instance
type AnyDrizzle = any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch over user's Drizzle table
type AnyTable = any;

export type CrudVerb = "list" | "get" | "create" | "update" | "delete";

export interface CrudRoutesOptions {
  fastify: FastifyInstance;
  /** REST resource path, e.g. "/subscribers". */
  path: string;
  /** User's Drizzle instance. */
  db: AnyDrizzle;
  /** Drizzle table const. The helper requires this to have an `id` column. */
  table: AnyTable;
  /** Zod schema for create payloads (typically `<Entity>InsertSchema`). */
  insertSchema: ZodTypeAny;
  /** Zod schema for update payloads (typically `<Entity>UpdateSchema`). */
  updateSchema: ZodTypeAny;
  /** Limit which verbs are mounted. Defaults to all five. */
  expose?: readonly CrudVerb[];
  /**
   * Fastify route-level hooks applied to every mounted verb (preHandler,
   * onRequest, schema validation, etc.). Most common use is auth:
   *   routeOptions: { preHandler: requireAuthHook }
   */
  routeOptions?: RouteShorthandOptions;
  /**
   * HTTP method for the update verb. Defaults to "patch". Set to "put" to
   * preserve a legacy API contract that already uses PUT for updates.
   */
  updateMethod?: "patch" | "put";
  filterAllowlist?: FilterAllowlist;
  sortAllowlist?:   SortAllowlist;
  /** Dialect — required if filterAllowlist or sortAllowlist is set (for like/ilike dispatch). */
  dialect?: "sqlite" | "postgres";
  /**
   * FR-017 TPH — scope this route set to a single subtype of a single-table-
   * inheritance base. When set:
   *   - list/get filter to `eq(table[column], value)`;
   *   - a get/update/delete targeting a row of another subtype 404s;
   *   - create injects `{ [column]: value }` AFTER body validation (the body
   *     omits the discriminator — the URL already names the subtype);
   *   - update strips `column` from the patch (a row's subtype is immutable).
   * Absent → ordinary single-table CRUD, behaviour unchanged.
   */
  discriminator?: { column: string; value: string };
}

const ALL_VERBS: readonly CrudVerb[] = ["list", "get", "create", "update", "delete"];

/** The TPH discriminator predicate for this route set, or undefined when the
 *  routes are not subtype-scoped. */
function discriminatorCond(opts: VerbOptions) {
  const d = opts.discriminator;
  return d ? eq(opts.table[d.column], d.value) : undefined;
}

export function mountCrudRoutes(opts: CrudRoutesOptions): void {
  const verbs = new Set<CrudVerb>(opts.expose ?? ALL_VERBS);
  if (verbs.has("list")) mountListRoute(opts);
  if (verbs.has("get")) mountGetRoute(opts);
  if (verbs.has("create")) mountCreateRoute(opts);
  if (verbs.has("update")) mountUpdateRoute(opts);
  if (verbs.has("delete")) mountDeleteRoute(opts);
}

type VerbOptions = Omit<CrudRoutesOptions, "expose">;

function routeOpts(opts: VerbOptions): RouteShorthandOptions {
  return opts.routeOptions ?? {};
}

export function mountListRoute(opts: VerbOptions): void {
  opts.fastify.get(opts.path, routeOpts(opts), async (req, reply) => {
    try {
      let q = opts.db.select().from(opts.table).$dynamic();
      // Re-parse the raw URL with qs so bracketed filter notation and the
      // top-level withCount flag are available.
      const rawSearch = req.raw.url?.includes("?")
        ? req.raw.url.slice(req.raw.url.indexOf("?") + 1)
        : "";
      const qsParsed = qs.parse(rawSearch) as Record<string, unknown>;
      const withCount = isTruthyFlag(qsParsed.withCount);

      // FR-017 TPH: when subtype-scoped, AND the discriminator predicate into
      // every list query (combined with any allowlist filters).
      const discCond = discriminatorCond(opts);

      let where: ReturnType<typeof parseFilterParams>["where"];
      if (opts.filterAllowlist && opts.sortAllowlist) {
        const parsed = parseFilterParams({
          query: qsParsed,
          table: opts.table,
          allowlist: opts.filterAllowlist,
          sortAllowlist: opts.sortAllowlist,
          dialect: opts.dialect ?? "sqlite",
        });
        const filterWhere = parsed.where && parsed.searchWhere
          ? and(parsed.where, parsed.searchWhere)
          : (parsed.where ?? parsed.searchWhere);
        const combinedWhere = filterWhere && discCond
          ? and(filterWhere, discCond)
          : (filterWhere ?? discCond);
        if (combinedWhere) { q = q.where(combinedWhere); where = combinedWhere; }
        // Default to stable id-ascending order when the caller specifies no
        // sort — the cross-port contract asserts deterministic ordering for
        // pagination + filter scenarios (Postgres otherwise returns rows in an
        // unspecified order).
        if (parsed.orderBy) q = q.orderBy(...parsed.orderBy);
        else if (opts.table.id !== undefined) q = q.orderBy(asc(opts.table.id));
        if (parsed.limit  !== undefined) q = q.limit(parsed.limit);
        if (parsed.offset !== undefined) q = q.offset(parsed.offset);
      } else {
        // Legacy path — no allowlists configured. Only limit/offset (+ the TPH
        // discriminator predicate when subtype-scoped).
        const { limit, offset } = req.query as { limit?: string; offset?: string };
        if (discCond) { q = q.where(discCond); where = discCond; }
        if (opts.table.id !== undefined) q = q.orderBy(asc(opts.table.id));
        if (limit  !== undefined) q = q.limit(Number(limit));
        if (offset !== undefined) q = q.offset(Number(offset));
      }

      // Await the query directly rather than calling `.all()`: the
      // drizzle-orm node-postgres query builder is thenable but has no `.all()`
      // method (that is a libsql/better-sqlite3-only API). Awaiting works on
      // both dialects and is what makes this helper genuinely Postgres-capable.
      const rows = await q;

      if (!withCount) return rows;

      // Count query: same WHERE, no limit/offset/orderBy.
      let cq = opts.db.select({ c: count() }).from(opts.table).$dynamic();
      if (where) cq = cq.where(where);
      const countRow = (await cq)[0] as { c: number } | undefined;
      const total = countRow?.c ?? 0;
      return { rows, total };
    } catch (err) {
      if (err instanceof FilterParseError) {
        return reply.code(400).send({ error: contractErrorCode(err.code), ...(err.details ?? {}) });
      }
      throw err;
    }
  });
}

export function mountGetRoute(opts: VerbOptions): void {
  opts.fastify.get(`${opts.path}/:id`, routeOpts(opts), async (req, reply) => {
    const { id } = req.params as { id: string };
    const discCond = discriminatorCond(opts);
    // Compare against the PK's real type — a numeric-LOOKING id on a TEXT pk
    // must stay a string ('0123' ≠ '123'), or affinity matches the WRONG row.
    const idValue = coerceIdForColumn(opts.table.id, id);
    if (idValue === undefined) {
      return reply.code(400).send({ error: "invalid_id" });
    }
    const idCond = eq(opts.table.id, idValue);
    // Await + take the first row rather than `.get()` — `.get()` is a
    // libsql/better-sqlite3-only method; the node-postgres builder is thenable
    // but has no `.get()`. Awaiting works on both dialects.
    const rows = await opts.db
      .select()
      .from(opts.table)
      .where(discCond ? and(idCond, discCond) : idCond)
      .limit(1);
    const row = (rows as unknown[])[0];
    return row ?? reply.code(404).send({ error: "not_found" });
  });
}

export function mountCreateRoute(opts: VerbOptions): void {
  opts.fastify.post(opts.path, routeOpts(opts), async (req, reply) => {
    const parsed = opts.insertSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    }
    // FR-017 TPH: the body omits the discriminator (the URL names the subtype);
    // inject it server-side so the row lands tagged with the right subtype.
    const values = opts.discriminator
      ? { ...(parsed.data as Record<string, unknown>), [opts.discriminator.column]: opts.discriminator.value }
      : parsed.data;
    const result = await opts.db.insert(opts.table).values(values).returning();
    const row = (result as unknown[])[0];
    return reply.code(201).send(row);
  });
}

export function mountUpdateRoute(opts: VerbOptions): void {
  const handler = async (
    req: { params: unknown; body: unknown },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ) => {
    const { id } = req.params as { id: string };
    const parsed = opts.updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    }
    const discCond = discriminatorCond(opts);
    // FR-017 TPH: a row's subtype is immutable — strip the discriminator from
    // the patch so a client can't flip a Bridge into a Copay.
    let data = parsed.data as Record<string, unknown>;
    if (opts.discriminator) {
      const { [opts.discriminator.column]: _omit, ...rest } = data;
      data = rest;
    }
    // Compare against the PK's real type (see mountGetRoute) — a numeric-
    // LOOKING id on a TEXT pk would otherwise UPDATE the wrong row.
    const idValue = coerceIdForColumn(opts.table.id, id);
    if (idValue === undefined) {
      return reply.code(400).send({ error: "invalid_id" });
    }
    const idCond = eq(opts.table.id, idValue);
    const result = await opts.db
      .update(opts.table)
      .set(data)
      .where(discCond ? and(idCond, discCond) : idCond)
      .returning();
    const row = (result as unknown[])[0];
    return row ?? reply.code(404).send({ error: "not_found" });
  };
  const path = `${opts.path}/:id`;
  const ro = routeOpts(opts);
  // Cross-port REST contract (FR-008): the update verb is reachable via BOTH
  // PATCH and PUT, each routed to the same handler (the Java/Kotlin/C#/Python
  // controllers map both methods to the update path). Mount both by default so
  // the generated TS routes match. `updateMethod` remains an explicit
  // single-verb override for a consumer that wants to restrict the surface.
  // biome-ignore lint/suspicious/noExplicitAny: handler signature is generic
  const h = handler as any;
  if (opts.updateMethod === "put") {
    opts.fastify.put(path, ro, h);
  } else if (opts.updateMethod === "patch") {
    opts.fastify.patch(path, ro, h);
  } else {
    opts.fastify.patch(path, ro, h);
    opts.fastify.put(path, ro, h);
  }
}

export function mountDeleteRoute(opts: VerbOptions): void {
  opts.fastify.delete(`${opts.path}/:id`, routeOpts(opts), async (req, reply) => {
    const { id } = req.params as { id: string };
    const discCond = discriminatorCond(opts);
    // Compare against the PK's real type (see mountGetRoute) — a numeric-
    // LOOKING id on a TEXT pk would otherwise DELETE the wrong row (data loss).
    const idValue = coerceIdForColumn(opts.table.id, id);
    if (idValue === undefined) {
      return reply.code(400).send({ error: "invalid_id" });
    }
    const idCond = eq(opts.table.id, idValue);
    const result = await opts.db
      .delete(opts.table)
      .where(discCond ? and(idCond, discCond) : idCond);
    // Both libsql and pg drivers expose a rows-affected counter, in different
    // shapes. Treat anything > 0 as "found and deleted."
    const affected = extractRowCount(result);
    return affected > 0
      ? reply.code(204).send()
      : reply.code(404).send({ error: "not_found" });
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
export { mountM2mRoute, type M2mRouteOptions } from "./mount-m2m.js";
