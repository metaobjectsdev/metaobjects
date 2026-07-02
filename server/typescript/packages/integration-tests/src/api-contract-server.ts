// api-contract-server.ts — minimal Fastify server implementing the cross-port
// REST API contract for the `Author` entity from the api-contract-conformance
// corpus.
//
// This is intentionally hand-rolled (rather than using the existing
// `routesFile()` codegen + `mountCrudRoutes`) because:
//
//   1. The corpus IS the contract — the runner needs to be a faithful
//      reference of the contract, not a downstream consumer of a generator
//      that may drift. If the generator and the contract diverge, the
//      generator is wrong.
//   2. The TS `runtime-ts/fastify` mountCrudRoutes helper does not yet
//      implement `withCount=1` or the `invalid_sort` 400 gate (those live in
//      `drizzle-fastify/mount-read-only.ts` which is Drizzle-only). Keeping
//      the runner self-contained avoids pulling Drizzle just for the test.
//   3. The TS Fastify server bound here is the **reference** that other ports'
//      controllers (Kotlin Spring, Java Spring, ASP.NET, FastAPI) must match.
//
// The server backs onto the standard `runtime-ts` ObjectManager + Kysely
// driver, so the persistence semantics are the same code-path other tests
// exercise.

import Fastify, { type FastifyInstance, type RouteHandlerMethod } from "fastify";
import { type MetaRoot } from "@metaobjectsdev/metadata";
import { ObjectManager, type Filter } from "@metaobjectsdev/runtime-ts";
import { kyselyDriver } from "@metaobjectsdev/runtime-ts/drivers";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { executeSql } from "./postgres-sql.ts";
import { bigintAsNumberTypes } from "./pg-bigint-number-types.ts";

const ENTITY = "Author";
const ROUTE_BASE = "/api/authors";
// Cross-port contract: the sort allowlist is the set of fields the server will
// accept in `?sort=<field>:asc|desc`. Anything else → 400 invalid_sort.
const SORT_ALLOWLIST = new Set(["id", "name", "createdAt"]);

// Cross-port contract: the filter allowlist gates which fields accept which
// operators in `?filter[<field>][<op>]=<value>`. Per FR-009 §5, operators are
// gated by field subtype:
//   string  → eq, ne, in, like, isNull
//   number  → eq, ne, gt, gte, lt, lte, in, isNull
//   date/timestamp → eq, ne, gt, gte, lt, lte, in, isNull
//   boolean → eq, isNull
const FILTER_ALLOWLIST: Record<string, { subType: "string" | "number" | "datetime" | "boolean"; ops: Set<string> }> = {
  id:        { subType: "number",   ops: new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"]) },
  name:      { subType: "string",   ops: new Set(["eq", "ne", "in", "like", "isNull"]) },
  bio:       { subType: "string",   ops: new Set(["eq", "ne", "in", "like", "isNull"]) },
  createdAt: { subType: "datetime", ops: new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"]) },
};

export interface ServerHandle {
  fastify: FastifyInstance;
  kysely: Kysely<Record<string, never>>;
  /** Base URL the server is listening on (http://127.0.0.1:<port>). */
  baseUrl: string;
  /** Truncate authors and restart the autoincrement id sequence. */
  truncate(): Promise<void>;
  /** Insert the seed rows (id-explicit, then advance the sequence). */
  applySeed(rows: AuthorRow[]): Promise<void>;
  close(): Promise<void>;
}

export interface AuthorRow {
  id?: number;
  name: string;
  bio?: string | null;
  createdAt: string;
}

/**
 * Spin up the Fastify reference server bound to a freshly-created
 * `authors` table on the provided Postgres connection.
 */
export async function startServer(connectionUri: string, root: MetaRoot): Promise<ServerHandle> {
  const kysely = new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({
      // BIGINT (OID 20) → Number is configured PER-POOL via `types`, not on the
      // global `pg` type registry. This corpus uses small ids (1-100) and its
      // expectations carry `id` as a JSON number, but a global mutation would
      // leak into the persistence-conformance query tests (which require the
      // default bigint→string wire contract) when both run in one process.
      pool: new Pool({ connectionString: connectionUri, types: bigintAsNumberTypes }),
    }),
  });

  // Hand-create the schema rather than going through migrate-ts. The corpus
  // explicitly pins the physical column names = field names (literal naming),
  // so a 4-line CREATE TABLE matches the entity exactly and is far easier to
  // reason about than the full migrate pipeline.
  await kysely.schema
    .createTable("authors")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("name", "varchar(100)", (c) => c.notNull())
    .addColumn("bio", "varchar(1000)")
    .addColumn("createdAt", "timestamp", (c) => c.notNull())
    .execute();

  const driver = kyselyDriver({ db: kysely as never, dialect: "postgres" });
  const om = new ObjectManager({ metadata: root, driver, columnNamingStrategy: "literal" });

  const fastify = Fastify();

  // Fastify pattern: every handler MUST either `return value` OR `reply.send()`,
  // never both — doing both raises ERR_HTTP_HEADERS_SENT. We use `reply.send()`
  // explicitly and return the reply object (Fastify's recommended async pattern
  // for branches with non-200 status codes).

  // GET /api/authors — list with filter + sort + pagination + withCount envelope.
  fastify.get(ROUTE_BASE, async (req, reply) => {
    const qs = req.query as Record<string, string | undefined>;
    const sort = parseSort(qs["sort"]);
    if (sort === "invalid") {
      reply.code(400).send({ error: "invalid_sort" });
      return reply;
    }

    // Filter parsing — Fastify's default qs parser leaves bracket-nested keys
    // flat (`filter[name][eq]` becomes a single string key), so we parse the
    // raw URL search string ourselves. Returns { error } on validation failure.
    const filterResult = parseFilterFromUrl(req.url);
    if ("error" in filterResult) {
      reply.code(400).send({ error: filterResult.error });
      return reply;
    }

    const limit = qs["limit"] !== undefined ? Number(qs["limit"]) : undefined;
    const offset = qs["offset"] !== undefined ? Number(qs["offset"]) : undefined;
    const withCount = qs["withCount"] === "1" || qs["withCount"] === "true";

    const opts: { orderBy?: [string, "asc" | "desc"][]; limit?: number; offset?: number } = {};
    // Default ordering is by `id` ascending — gives pagination stability across
    // ports without forcing the caller to specify sort everywhere.
    opts.orderBy = sort ? [sort] : [["id", "asc"]];
    if (limit !== undefined) opts.limit = limit;
    if (offset !== undefined) opts.offset = offset;

    const rows = await om.findMany(ENTITY, filterResult.filter, opts);
    if (!withCount) return rows;
    const total = await om.count(ENTITY, filterResult.filter);
    return { rows, total };
  });

  // GET /api/authors/:id
  fastify.get(`${ROUTE_BASE}/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await om.findById(ENTITY, Number(id));
    if (row) return row;
    reply.code(404).send({ error: "not_found" });
    return reply;
  });

  // POST /api/authors
  fastify.post(ROUTE_BASE, async (req, reply) => {
    const row = await om.create(ENTITY, req.body as Record<string, unknown>);
    reply.code(201).send(row);
    return reply;
  });

  // PATCH + PUT /api/authors/:id — same body shape per the cross-port contract.
  const updateHandler: RouteHandlerMethod = async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await om.update(ENTITY, Number(id), req.body as Record<string, unknown>, { ifMissing: "ignore" });
    if (row) return row;
    reply.code(404).send({ error: "not_found" });
    return reply;
  };
  fastify.patch(`${ROUTE_BASE}/:id`, updateHandler);
  fastify.put(`${ROUTE_BASE}/:id`, updateHandler);

  // DELETE /api/authors/:id
  fastify.delete(`${ROUTE_BASE}/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await om.delete(ENTITY, Number(id), { ifMissing: "ignore" });
    if (ok) reply.code(204).send();
    else reply.code(404).send({ error: "not_found" });
    return reply;
  });

  // Listen on a real ephemeral port. fastify.inject() (light-my-request) has
  // compat issues under bun's http server impl — using a real port + fetch
  // is the boring, portable path.
  const baseUrl = await fastify.listen({ host: "127.0.0.1", port: 0 });

  return {
    fastify,
    kysely,
    baseUrl,
    truncate: async () => {
      // RESTART IDENTITY rewinds the bigserial sequence so create-201 lands at
      // a deterministic id when the test order matters. Used by list-empty.
      await executeSql(connectionUri, 'TRUNCATE TABLE "authors" RESTART IDENTITY');
    },
    applySeed: async (rows: AuthorRow[]) => {
      await executeSql(connectionUri, 'TRUNCATE TABLE "authors" RESTART IDENTITY');
      for (const r of rows) {
        await om.create(ENTITY, r as unknown as Record<string, unknown>);
      }
      // After explicit-id inserts, bump the bigserial sequence past the max id
      // so the next implicit-id create lands at id = max+1.
      await executeSql(
        connectionUri,
        `SELECT setval(pg_get_serial_sequence('authors', 'id'), COALESCE((SELECT MAX(id) FROM authors), 1))`,
      );
    },
    close: async () => {
      await fastify.close();
      await kysely.destroy();
    },
  };
}

/**
 * Parse `filter[<field>][<op>]=<value>` (and the `filter[<field>]=<value>` =eq
 * sugar form) from a raw request URL. Multiple `filter[...]` params combine
 * with implicit-AND.
 *
 * The hand-rolled raw parse is deliberate: Fastify's default querystring
 * parser flattens bracket keys into single strings (`filter[name][eq]`),
 * and the runtime-ts/drizzle-fastify parser is Drizzle-SQL-specific. We
 * only need to produce an ObjectManager `Filter` for this reference server.
 *
 * Returns `{ filter }` on success (filter is `undefined` when no filter params
 * are present) or `{ error }` on validation failure.
 */
// Cross-port cap on `in`-list size. A larger list is rejected with the
// `filter.in_too_large` envelope so a caller cannot force an unbounded
// IN (...) against the DB. Matches the runtime-ts filter parser's
// DEFAULT_MAX_IN_LIST and every other port's generated parser.
const MAX_IN_LIST = 100;

function parseFilterFromUrl(
  url: string,
): { filter: Filter | undefined } | { error: "invalid_filter_field" | "invalid_filter_op" | "invalid_filter_value" | "filter.in_too_large" } {
  const qIdx = url.indexOf("?");
  if (qIdx === -1) return { filter: undefined };
  const search = url.slice(qIdx + 1);

  const entries: { field: string; op: string; value: string }[] = [];
  for (const pair of search.split("&")) {
    if (!pair) continue;
    const eqIdx = pair.indexOf("=");
    const rawKey = eqIdx === -1 ? pair : pair.slice(0, eqIdx);
    const rawValue = eqIdx === -1 ? "" : pair.slice(eqIdx + 1);
    const key = decodeURIComponent(rawKey.replace(/\+/g, "%20"));
    const value = decodeURIComponent(rawValue.replace(/\+/g, "%20"));
    if (!key.startsWith("filter[")) continue;
    // Match filter[field] or filter[field][op]
    const match = key.match(/^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/);
    if (!match) continue;
    const field = match[1]!;
    const op = match[2] ?? "eq";
    entries.push({ field, op, value });
  }

  if (entries.length === 0) return { filter: undefined };

  const subFilters: Filter[] = [];
  for (const e of entries) {
    const rule = FILTER_ALLOWLIST[e.field];
    if (!rule) return { error: "invalid_filter_field" };
    if (!rule.ops.has(e.op)) return { error: "invalid_filter_op" };
    const coerced = coerceFilterValue(e.value, rule.subType, e.op);
    if (coerced === INVALID) return { error: "invalid_filter_value" };
    if (e.op === "in" && Array.isArray(coerced) && coerced.length > MAX_IN_LIST) {
      return { error: "filter.in_too_large" };
    }
    subFilters.push({ [e.field]: { [`$${e.op}`]: coerced } } as Filter);
  }

  if (subFilters.length === 1) return { filter: subFilters[0]! };
  return { filter: { $and: subFilters } };
}

const INVALID = Symbol("invalid-filter-value");

function coerceFilterValue(
  raw: string,
  subType: "string" | "number" | "datetime" | "boolean",
  op: string,
): string | number | boolean | (string | number)[] | typeof INVALID {
  if (op === "isNull") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    return INVALID;
  }
  if (op === "in") {
    const parts = raw.split(",").map((s) => s.trim());
    if (subType === "number") {
      const nums = parts.map((s) => Number(s));
      if (nums.some((n) => !Number.isFinite(n))) return INVALID;
      return nums;
    }
    return parts;
  }
  switch (subType) {
    case "string":
    case "datetime":
      // The repository binds these via parameterized SQL; the driver coerces
      // the raw string to the column type (varchar / timestamp respectively).
      return raw;
    case "boolean":
      if (raw === "true") return true;
      if (raw === "false") return false;
      return INVALID;
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) return INVALID;
      return n;
    }
  }
}

/**
 * Parse a `?sort=<field>:<dir>` value.
 *   - `null` → no sort param present
 *   - `"invalid"` sentinel → the field/dir is malformed or off-allowlist
 *   - `[field, dir]` → valid
 */
function parseSort(raw: string | undefined): [string, "asc" | "desc"] | null | "invalid" {
  if (raw === undefined || raw === "") return null;
  const [field, dirRaw] = raw.split(":", 2);
  if (!field || !SORT_ALLOWLIST.has(field)) return "invalid";
  const dir = (dirRaw ?? "asc").toLowerCase();
  if (dir !== "asc" && dir !== "desc") return "invalid";
  return [field, dir];
}
