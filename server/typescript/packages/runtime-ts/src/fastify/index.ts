// REFERENCE HELPER, not core (ADR-0034 Amendment 3, 2026-09-24 ruling). Only generated
// route files call this; eject the route generator and you own that call, and can mount
// routes by hand instead. The wire contract it answers with is what MetaObjects gates
// (api-contract-conformance), not this adapter.
//
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
import { withConstraintMapping } from "../constraint-errors.js";
import type { ZodTypeAny } from "zod";
import { validationErrorBody } from "../route-errors.js";
import { parseListQuery, parseListQueryString, rawQueryOf, type FilterNode, type ListQuery } from "../drizzle-fastify/list-query.js";
import type { ObjectManager } from "../object-manager.js";
import type { Row } from "../persistence-driver.js";
import type { RouteShorthandOptions } from "fastify";
import type { FilterAllowlist, SortAllowlist } from "../drizzle-fastify/filter-allowlist.js";
import { isTruthyFlag, contractErrorCode } from "../drizzle-fastify/util.js";
import { FilterParseError, pageLimit, type PageSize } from "../drizzle-fastify/list-params.js";
import type { Filter } from "../query-builder.js";
import { withContractErrorHandler } from "../drizzle-fastify/route-error-handler.js";

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
   * Restrict the update verb to ONE HTTP method. Absent (the default) mounts
   * the update handler on both PATCH and PUT, as the cross-port REST contract
   * requires.
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
  /**
   * Per-entity filter allowlist (`<Entity>FilterAllowlist` from codegen). When set, the list
   * reads `filter[...]`, `filter[or]` / `filter[and]` and `?search`, and refuses what the
   * REST standard refuses (a bare field parameter, a leading `%`, a malformed value, a
   * filter nested too deep) with the same bodies as the Drizzle mounts: both parse through
   * `parseListQuery`. Absent, `?filter` and `?search` are ignored, as before.
   */
  filterAllowlist?: FilterAllowlist;
  /**
   * The list page size (`api.pagination` in `.metaobjects/config.json`): a list with no
   * `limit` returns `defaultLimit` rows, and a `limit` above `maxLimit` answers
   * `400 { "error": "limit_too_large", "maxLimit": N }`. Absent: no default and no ceiling.
   */
  pagination?: PageSize;
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
 * Build the route options Fastify wants: the consumer's routeOptions plus the
 * route-scoped contract error handler shared with drizzle-fastify (an unexpected
 * error answers `500 { error: "internal" }` instead of Fastify's default, which
 * echoes the driver message; a malformed JSON body answers
 * `400 { error: "invalid_json" }`). A consumer-supplied `errorHandler` wins.
 */
function routeOpts(opts: SingleVerbOptions): RouteShorthandOptions {
  return withContractErrorHandler(opts.routeOptions);
}

export function mountListRoute(opts: SingleVerbOptions): void {
  opts.fastify.get(opts.path, routeOpts(opts), async (req, reply) => {
    // Re-parse the raw URL so bracketed filter notation, the top-level withCount flag and
    // the sort=field:dir param are available regardless of Fastify's query parser.
    const parsed = parseListQueryString(rawQueryOf(req.raw.url));
    const withCount = isTruthyFlag(parsed["withCount"]);

    const om = await opts.om();
    let query: ListQuery;
    let limit: number | undefined;
    try {
      query = opts.filterAllowlist !== undefined
        ? parseListQuery({
            query: opts.sortAllowlist !== undefined ? parsed : withoutSort(parsed),
            allowlist: opts.filterAllowlist,
            sortAllowlist: opts.sortAllowlist ?? {},
            isField: (name) => om.fieldNames(opts.entity).includes(name),
          })
        : parseListQuery({ query: pageAndSortOnly(parsed, opts.sortAllowlist !== undefined), allowlist: {}, sortAllowlist: opts.sortAllowlist ?? {} });
      limit = pageLimit(query.limit, opts.pagination);
    } catch (err) {
      if (err instanceof FilterParseError) return reply.code(400).send({ error: contractErrorCode(err.code), ...(err.details ?? {}) });
      throw err;
    }

    const readOpts: { limit?: number; offset?: number; orderBy?: [string, "asc" | "desc"] | [string, "asc" | "desc"][] } = {};
    if (limit !== undefined) readOpts.limit = limit;
    if (query.offset !== undefined) readOpts.offset = query.offset;
    // No `?sort`: the key, ascending, so a page holds the same rows on every engine, as the
    // Drizzle mounts order by `id`.
    if (query.sort !== undefined) readOpts.orderBy = [query.sort.field, query.sort.order];
    else {
      const key = om.keyFields(opts.entity);
      if (key.length === 1) readOpts.orderBy = [key[0] as string, "asc"];
      else if (key.length > 1) readOpts.orderBy = key.map((f): [string, "asc" | "desc"] => [f, "asc"]);
    }

    const filter = listFilter(query);
    const rows = await om.findMany(opts.entity, filter, readOpts);
    if (!withCount) return rows;
    // total is the UNPAGINATED count of the same filter (no limit/offset).
    const total = await om.count(opts.entity, filter);
    return { rows, total };
  });
}

/**
 * With no filter allowlist the mount reads only the page and (when a sort allowlist is set)
 * the sort, as it always has: `?filter` and `?search` are ignored and no bare parameter is
 * refused, because there is no list of filterable fields to check them against.
 */
function pageAndSortOnly(parsed: Record<string, unknown>, withSort: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["limit", "offset", ...(withSort ? ["sort"] : [])]) if (k in parsed) out[k] = parsed[k];
  return out;
}

function withoutSort(parsed: Record<string, unknown>): Record<string, unknown> {
  const { sort: _sort, ...rest } = parsed;
  return rest;
}

/** The parsed filter tree and search as one ObjectManager filter (the AND of the two). */
function listFilter(query: ListQuery): Filter | undefined {
  const parts: Filter[] = [];
  if (query.filter !== undefined) parts.push(toOmFilter(query.filter));
  if (query.search !== undefined) {
    const pattern = `%${query.search.term}%`;
    const branches = query.search.fields.map((f): Filter => ({ [f]: { $ilike: pattern } }));
    parts.push(branches.length === 1 ? (branches[0] as Filter) : { $or: branches });
  }
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : { $and: parts };
}

function toOmFilter(node: FilterNode): Filter {
  if ("and" in node) return { $and: node.and.map(toOmFilter) };
  if ("or" in node) return { $or: node.or.map(toOmFilter) };
  return { [node.field]: { [`$${node.op}`]: node.value } } as Filter;
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
      return reply.code(400).send(validationErrorBody(parsed.error.issues));
    }
    // Zod returns `unknown` for parsed.data; the schema is authored from the
    // same metadata that drives ObjectManager, so the shape is guaranteed
    // compatible — cast at the trust boundary.
    // A declared constraint the DB enforces (a foreign key from identity.reference,
    // a unique index) must not surface as a 500 echoing the SQL and its bound params.
    return withConstraintMapping(
      async () => {
        const row = await (await opts.om()).create(opts.entity, parsed.data as Row);
        return reply.code(201).send(row);
      },
      (f) => reply.code(f.status).send(f.body),
    );
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
      return reply.code(400).send(validationErrorBody(parsed.error.issues));
    }
    // Use ifMissing: "ignore" so the helper itself owns the 404 mapping
    // (consistent with mountDeleteRoute). ObjectManager's default behavior
    // throws NotFoundError, which Fastify would surface as 500.
    // Raw id — ObjectManager coerces per PK metadata (see mountGetRoute).
    return withConstraintMapping(
      async () => {
        const row = await (await opts.om()).update(opts.entity, id, parsed.data as Row, {
          ifMissing: "ignore",
        });
        return row ?? reply.code(404).send({ error: "not_found" });
      },
      (f) => reply.code(f.status).send(f.body),
    );
  };
  const path = `${opts.path}/:id`;
  const ro = routeOpts(opts);
  // Cross-port REST contract (FR-008): the update verb is reachable via BOTH PATCH
  // and PUT, each routed to the same handler — as the drizzle-fastify flavor and
  // every other port's controller do. `updateMethod` stays an explicit single-verb
  // override for a consumer that wants to restrict the surface.
  // biome-ignore lint/suspicious/noExplicitAny: handler signature is generic by design
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

export function mountDeleteRoute(opts: SingleVerbOptions): void {
  opts.fastify.delete(`${opts.path}/:id`, routeOpts(opts), async (req, reply) => {
    const { id } = req.params as { id: string };
    // Raw id — ObjectManager coerces per PK metadata (see mountGetRoute).
    // Pre-coercing conflated '0123' with 123 on a string pk: wrong-row DELETE.
    return withConstraintMapping(
      async () => {
        // ifMissing: "ignore" so this route owns the 404, as the update route does.
        // ObjectManager's default throws NotFoundError, which is not a constraint
        // failure and so left as the redacted 500.
        const deleted = await (await opts.om()).delete(opts.entity, id, { ifMissing: "ignore" });
        return deleted ? reply.code(204).send() : reply.code(404).send({ error: "not_found" });
      },
      (f) => reply.code(f.status).send(f.body),
    );
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Back-compat re-export — the unsafe local copy was consolidated onto the one
// shared (deprecated) helper so the three adapters can't silently diverge.
// The mounts above no longer use it: ObjectManager coerces ids per metadata.
export { parseId } from "../drizzle-fastify/util.js";

// ---------------------------------------------------------------------------
// Metadata endpoint
// ---------------------------------------------------------------------------

import type { MetaData } from "@metaobjectsdev/metadata";
import { META_ROUTE_PATH, META_CONTENT_TYPE, metaJson } from "../meta-endpoint.js";

export interface MetaRouteOptions {
  fastify: FastifyInstance;
  /** The loaded model root. */
  root: MetaData;
  /** Mounted under this prefix; defaults to "" (the bare `/_meta`). */
  prefix?: string;
}

/**
 * Mount `GET {prefix}/_meta`, serving the model as effective canonical JSON.
 *
 * Opt-in by design. `/_meta` publishes the SHAPE of the model — entity and field
 * names, types, validators, layouts — though no row data. Guard it with your own
 * middleware exactly as you would the generated routes (#367):
 *
 *     app.register(async (s) => {
 *       s.addHook("preHandler", requireAuth);
 *       mountMetaRoute({ fastify: s, root, prefix: "/api" });
 *     });
 *
 * The body is serialized once per call. If that ever matters, cache it in the
 * host — the model is immutable after load.
 */
export function mountMetaRoute(opts: MetaRouteOptions): void {
  const path = `${opts.prefix ?? ""}${META_ROUTE_PATH}`;
  opts.fastify.get(path, withContractErrorHandler(undefined), async (_req, reply) => {
    return reply
      .code(200)
      .header("content-type", META_CONTENT_TYPE)
      .send(metaJson(opts.root));
  });
}
