// Fastify adapter for ObjectManager-driven CRUD.
//
// Generated route files call `mountCrudRoutes(...)` from here so all the
// boilerplate (validation, 404 mapping, id parsing, pagination) lives in
// one tested place rather than being duplicated per entity.
//
// Fastify is an OPTIONAL peer dependency. Consumers that don't expose REST
// pay no runtime cost — this subpath is only loaded when imported.
//
// Type-only Fastify imports keep the optional-peer story clean: the .d.ts
// reference is needed for the public API, but at runtime there's no
// `require("fastify")`.

import type { FastifyInstance } from "fastify";
import type { ZodTypeAny } from "zod";
import qs from "qs";
import type { ObjectManager } from "../object-manager.js";
import type { Row } from "../persistence-driver.js";
import type { RouteShorthandOptions } from "fastify";
import type { SortAllowlist } from "../drizzle-fastify/filter-allowlist.js";
import { isTruthyFlag, contractErrorCode } from "../drizzle-fastify/util.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type CrudVerb = "list" | "get" | "create" | "update" | "delete";

export interface CrudRoutesOptions {
  fastify: FastifyInstance;
  /** REST resource path, e.g. "/subscribers". */
  path: string;
  /** Entity name from metadata, e.g. "Subscriber". */
  entity: string;
  /** Zod schema for create payloads (typically `<Entity>InsertSchema`). */
  insertSchema: ZodTypeAny;
  /** Zod schema for update payloads (typically `<Entity>UpdateSchema`). */
  updateSchema: ZodTypeAny;
  /**
   * ObjectManager accessor. A function rather than the instance so callers
   * can keep their lazy-init pattern (load metadata once at startup).
   */
  om: () => Promise<ObjectManager>;
  /**
   * Limit which verbs are mounted. Defaults to all five. Useful for
   * read-only resources (`expose: ["list", "get"]`).
   */
  expose?: readonly CrudVerb[];
  /**
   * Fastify route-level hooks applied to every mounted verb. The most common
   * use is `preHandler` for auth/authz:
   *
   *   routeOptions: { preHandler: requireAdminAuth }
   *
   * Anything Fastify accepts on a route options object is valid here
   * (preHandler, onRequest, preValidation, preParsing, schema, etc.).
   */
  routeOptions?: RouteShorthandOptions;
  /**
   * HTTP method for the update verb. Defaults to "patch" (semantic partial-
   * update). Set to "put" to preserve a legacy API contract that already
   * uses PUT for updates.
   */
  updateMethod?: "patch" | "put";
  /**
   * Per-entity sort allowlist (`<Entity>SortAllowlist` from codegen). When set,
   * a `?sort=field:dir` referencing a field NOT in the allowlist (or an invalid
   * order) is rejected with HTTP 400 `{ error: "invalid_sort" }` — matching the
   * cross-port REST contract and the drizzle-fastify mount. When absent, `?sort`
   * is ignored (legacy back-compat: limit/offset only).
   */
  sortAllowlist?: SortAllowlist;
}

const ALL_VERBS: readonly CrudVerb[] = ["list", "get", "create", "update", "delete"];

/**
 * Mount the 5 standard REST endpoints for an entity:
 *
 *   GET    {path}      → list, with ?limit & ?offset query params
 *   GET    {path}/:id  → findById
 *   POST   {path}      → create (validated via insertSchema)
 *   PATCH  {path}/:id  → partial update (validated via updateSchema)
 *   DELETE {path}/:id  → delete
 */
export function mountCrudRoutes(opts: CrudRoutesOptions): void {
  const verbs = new Set<CrudVerb>(opts.expose ?? ALL_VERBS);
  if (verbs.has("list")) mountListRoute(opts);
  if (verbs.has("get")) mountGetRoute(opts);
  if (verbs.has("create")) mountCreateRoute(opts);
  if (verbs.has("update")) mountUpdateRoute(opts);
  if (verbs.has("delete")) mountDeleteRoute(opts);
}

// ---------------------------------------------------------------------------
// Per-verb helpers — exposed so consumers can mix custom routes with the
// generated CRUD. Each takes the same options bag (minus `expose`).
// ---------------------------------------------------------------------------

type SingleVerbOptions = Omit<CrudRoutesOptions, "expose">;

/**
 * Build the route options Fastify wants. Just the consumer's routeOptions
 * (typed loosely to avoid Fastify's elaborate route-options union here).
 * Returns an empty object if nothing was provided.
 */
function routeOpts(opts: SingleVerbOptions): RouteShorthandOptions {
  return opts.routeOptions ?? {};
}

export function mountListRoute(opts: SingleVerbOptions): void {
  opts.fastify.get(opts.path, routeOpts(opts), async (req, reply) => {
    // Re-parse the raw URL with qs so the top-level withCount flag and the
    // sort=field:dir param are available regardless of Fastify's query parser.
    const rawSearch = req.raw.url?.includes("?")
      ? req.raw.url.slice(req.raw.url.indexOf("?") + 1)
      : "";
    const parsed = qs.parse(rawSearch) as Record<string, unknown>;
    const withCount = isTruthyFlag(parsed["withCount"]);

    const readOpts: { limit?: number; offset?: number; orderBy?: [string, "asc" | "desc"] } = {};
    const { limit, offset } = req.query as { limit?: string; offset?: string };
    if (limit !== undefined) readOpts.limit = Number(limit);
    if (offset !== undefined) readOpts.offset = Number(offset);

    // Sort allowlist gate (cross-port REST contract). Only enforced when a
    // sortAllowlist is configured; absent → ?sort is ignored (back-compat).
    if (opts.sortAllowlist && typeof parsed["sort"] === "string") {
      const sortParse = parseSort(parsed["sort"], opts.sortAllowlist);
      if (sortParse.error) {
        return reply.code(400).send({ error: contractErrorCode(sortParse.error) });
      }
      if (sortParse.orderBy) readOpts.orderBy = sortParse.orderBy;
    }

    const om = await opts.om();
    const rows = await om.findMany(opts.entity, undefined, readOpts);
    if (!withCount) return rows;
    // total is the UNPAGINATED count (no limit/offset).
    const total = await om.count(opts.entity);
    return { rows, total };
  });
}

/**
 * Validate a `sort=field:dir` spec against the allowlist. Mirrors the
 * drizzle-fastify filter-parser's sort semantics + internal error codes
 * (`sort.unknown_field` / `sort.invalid_order`) so both mounts emit the same
 * `invalid_sort` envelope at the HTTP boundary.
 */
function parseSort(
  spec: string,
  sortAllowlist: SortAllowlist,
): { orderBy?: [string, "asc" | "desc"]; error?: string } {
  const [field, orderRaw] = spec.split(":");
  if (!field || !sortAllowlist[field]) return { error: "sort.unknown_field" };
  const order = (orderRaw ?? "asc").toLowerCase();
  if (order !== "asc" && order !== "desc") return { error: "sort.invalid_order" };
  return { orderBy: [field, order] };
}

export function mountGetRoute(opts: SingleVerbOptions): void {
  opts.fastify.get(`${opts.path}/:id`, routeOpts(opts), async (req, reply) => {
    const { id } = req.params as { id: string };
    // Pass the RAW path param — ObjectManager coerces it against the PK field's
    // declared metadata type. Pre-coercing here through parseId conflated
    // '0123' with 123 on a string pk, hitting the WRONG row.
    const row = await (await opts.om()).findById(opts.entity, id);
    return row ?? reply.code(404).send({ error: "not_found" });
  });
}

export function mountCreateRoute(opts: SingleVerbOptions): void {
  opts.fastify.post(opts.path, routeOpts(opts), async (req, reply) => {
    const parsed = opts.insertSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    }
    // Zod returns `unknown` for parsed.data; the schema is authored from the
    // same metadata that drives ObjectManager, so the shape is guaranteed
    // compatible — cast at the trust boundary.
    const row = await (await opts.om()).create(opts.entity, parsed.data as Row);
    return reply.code(201).send(row);
  });
}

export function mountUpdateRoute(opts: SingleVerbOptions): void {
  const handler = async (
    req: { params: unknown; body: unknown },
    reply: {
      code: (n: number) => { send: (b: unknown) => unknown };
    },
  ) => {
    const { id } = req.params as { id: string };
    const parsed = opts.updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    }
    // Use ifMissing: "ignore" so the helper itself owns the 404 mapping
    // (consistent with mountDeleteRoute). ObjectManager's default behavior
    // throws NotFoundError, which Fastify would surface as 500.
    // Raw id — ObjectManager coerces per PK metadata (see mountGetRoute).
    const row = await (await opts.om()).update(opts.entity, id, parsed.data as Row, {
      ifMissing: "ignore",
    });
    return row ?? reply.code(404).send({ error: "not_found" });
  };
  const path = `${opts.path}/:id`;
  const ro = routeOpts(opts);
  // biome-ignore lint/suspicious/noExplicitAny: handler signature is generic by design
  if (opts.updateMethod === "put") {
    opts.fastify.put(path, ro, handler as any);
  } else {
    opts.fastify.patch(path, ro, handler as any);
  }
}

export function mountDeleteRoute(opts: SingleVerbOptions): void {
  opts.fastify.delete(`${opts.path}/:id`, routeOpts(opts), async (req, reply) => {
    const { id } = req.params as { id: string };
    // Raw id — ObjectManager coerces per PK metadata (see mountGetRoute).
    // Pre-coercing conflated '0123' with 123 on a string pk: wrong-row DELETE.
    const deleted = await (await opts.om()).delete(opts.entity, id);
    return deleted ? reply.code(204).send() : reply.code(404).send({ error: "not_found" });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Back-compat re-export — the unsafe local copy was consolidated onto the one
// shared (deprecated) helper so the three adapters can't silently diverge.
// The mounts above no longer use it: ObjectManager coerces ids per metadata.
export { parseId } from "../drizzle-fastify/util.js";
