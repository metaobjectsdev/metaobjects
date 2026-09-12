/**
 * The auth recipe printed in generated routes files, EXECUTED.
 *
 * #367: an agent building a real API read `Customize via <Entity>.extra.ts (e.g., auth,
 * additional handlers)` at the top of a generated routes file, went looking for that
 * seam, found that nothing imports a sibling module, and deleted `routesFile()` from its
 * config rather than mount five unauthenticated endpoints over a password-hash table.
 * The seam it needed existed in both frameworks the whole time; only the generated output
 * did not say so. It does now — `authSeamJsDoc` in `codegen-ts/src/routes-expose.ts`
 * stamps the recipe into every generated handler's JSDoc.
 *
 * This file is why that recipe is trustworthy. A wrong recipe in generated output is the
 * SAME defect as a recipe for a seam that does not exist, one size smaller — so each
 * framework's snippet is reproduced here against the real mount helpers and asserted to
 * actually guard, with an unguarded sibling route proving the guard is scoped rather than
 * global. The mounts are written exactly as codegen emits them, including Fastify's inner
 * `register(..., { prefix })`, because that nesting is the part a reader would doubt.
 *
 * If you change a recipe's shape, change it here first and watch this go red.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Hono } from "hono";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, sqliteView, integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { mountCrudRoutes } from "../src/drizzle-fastify/index.js";
import { mountReadOnlyCrudRoutes } from "../src/drizzle-fastify/mount-read-only.js";
import { mountCrudRoutes as mountHonoCrud } from "../src/hono/index.js";
import type { FilterAllowlist, SortAllowlist } from "../src/drizzle-fastify/filter-allowlist.js";

const InsertSchema = z.object({ id: z.number().optional(), title: z.string() });
const UpdateSchema = InsertSchema.partial();

const secretsTable = () =>
  sqliteTable("secrets", {
    id: integer("id").primaryKey(),
    title: text("title").notNull(),
  });

async function seed(client: Client): Promise<void> {
  await client.execute(`CREATE TABLE secrets (id INTEGER PRIMARY KEY, title TEXT NOT NULL)`);
  await client.execute(`INSERT INTO secrets (id, title) VALUES (1, 'classified')`);
  await client.execute(`CREATE VIEW v_secrets AS SELECT id, title FROM secrets`);
}

/** The hook an adopter supplies. 401s anything without an Authorization header. */
// biome-ignore lint/suspicious/noExplicitAny: fastify hook signature varies by scope generics
const requireAuth = async (req: any, reply: any) => {
  if (!req.headers.authorization) {
    reply.code(401);
    return reply.send({ error: "unauthorized" });
  }
};

// ---------------------------------------------------------------------------
// Fastify — the recipe emitted for every writable/TPH/projection handler:
//
//   app.register(async (s) => {
//     s.addHook("preHandler", requireAuth);
//     await registerSecretRoutes(s);
//   });
//
// The claim under test is specifically that the hook reaches THROUGH the
// generated handler's own `fastify.register(..., { prefix })` — Fastify hooks
// are encapsulated per plugin scope and inherited by child scopes, which is
// what makes the four-line wrap sufficient with no codegen change at all.
// ---------------------------------------------------------------------------
describe("fastify — a parent-scope preHandler guards the generated mount", () => {
  let client: Client;
  let app: FastifyInstance;

  /** Byte-for-byte the shape `renderRoutesFile` emits under an apiPrefix. */
  async function registerSecretRoutes(fastify: FastifyInstance): Promise<void> {
    // biome-ignore lint/suspicious/noExplicitAny: drizzle client is dynamically typed here
    const db = drizzle(client) as any;
    await fastify.register(
      async (instance) => {
        mountCrudRoutes({
          fastify: instance,
          path: "/secrets",
          db,
          table: secretsTable(),
          insertSchema: InsertSchema,
          updateSchema: UpdateSchema,
          dialect: "sqlite",
        });
      },
      { prefix: "/api" },
    );
  }

  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    await seed(client);
    app = Fastify();
    await app.register(async (s) => {
      s.addHook("preHandler", requireAuth);
      await registerSecretRoutes(s);
    });
    // A sibling route OUTSIDE the guarded scope — proves the hook is scoped.
    app.get("/health", async () => ({ ok: true }));
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    client.close();
  });

  const verbs: ReadonlyArray<[string, string]> = [
    ["GET", "/api/secrets"],
    ["GET", "/api/secrets/1"],
    ["POST", "/api/secrets"],
    ["PATCH", "/api/secrets/1"],
    ["DELETE", "/api/secrets/1"],
  ];

  for (const [method, url] of verbs) {
    test(`${method} ${url} is 401 without the header`, async () => {
      // Only send a body (and its content-type) on the verbs that carry one: Fastify
      // parses the body BEFORE preHandler, so a declared-but-absent JSON body 400s
      // ahead of the hook and would hide what this asserts.
      const hasBody = method === "POST" || method === "PATCH";
      const res = await app.inject({
        method: method as "GET",
        url,
        ...(hasBody
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) }
          : {}),
      });
      expect(res.statusCode).toBe(401);
    });
  }

  test("GET /api/secrets serves the rows once the header is present", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/secrets",
      headers: { authorization: "token" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveLength(1);
  });

  test("a route outside the scope stays open — the guard is scoped, not global", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Fastify projection mount — `routeOptions` parity.
//
// mountCrudRoutes and mountM2mRoute took route-level hooks; mountReadOnlyCrudRoutes
// did not, so a generated projection route could not carry one the way a generated
// entity route could. Read-only is not public.
// ---------------------------------------------------------------------------
describe("fastify — mountReadOnlyCrudRoutes honors routeOptions", () => {
  let client: Client;
  let app: FastifyInstance;

  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    await seed(client);
    const view = sqliteView("v_secrets", {
      id: integer("id").notNull(),
      title: text("title").notNull(),
    }).existing();
    const filterAllowlist: FilterAllowlist = {
      title: { ops: ["eq"], subType: "string", leadingWildcard: true },
    };
    const sortAllowlist: SortAllowlist = { id: { defaultOrder: "asc" } };

    app = Fastify();
    mountReadOnlyCrudRoutes({
      fastify: app,
      path: "/secret-summaries",
      db: drizzle(client),
      view,
      filterAllowlist,
      sortAllowlist,
      dialect: "sqlite",
      routeOptions: { preHandler: requireAuth },
    });
    app.get("/health", async () => ({ ok: true }));
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    client.close();
  });

  test("GET list is 401 without the header", async () => {
    const res = await app.inject({ method: "GET", url: "/secret-summaries" });
    expect(res.statusCode).toBe(401);
  });

  test("GET :id is 401 without the header", async () => {
    const res = await app.inject({ method: "GET", url: "/secret-summaries/1" });
    expect(res.statusCode).toBe(401);
  });

  test("the hook runs before the 405 rejection on a write verb", async () => {
    const res = await app.inject({ method: "POST", url: "/secret-summaries", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  test("with the header, the read serves normally", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/secret-summaries",
      headers: { authorization: "token" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveLength(1);
  });

  test("a route mounted beside it stays open", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Hono — the recipe emitted for every generated Hono handler:
//
//   app.use(`${Secret.$path}/*`, requireAuth);   // matches the collection path too
//   registerSecretRoutes(app, { db });
//
// The trailing wildcard is the counter-intuitive half and the reason this is a
// test rather than a comment: `"/api/secrets/*"` matches `/api/secrets` ITSELF,
// so ONE app.use covers the collection route as well as every :id route. Get
// that wrong and list/create stay wide open while the recipe reads correct.
// ---------------------------------------------------------------------------
describe("hono — app.use with a trailing wildcard guards the generated mount", () => {
  let client: Client;
  // biome-ignore lint/suspicious/noExplicitAny: consumer-defined Hono bindings/variables
  let app: Hono<any, any, any>;

  // biome-ignore lint/suspicious/noExplicitAny: mirrors the emitted handler signature
  function registerSecretRoutes(a: Hono<any, any, any>, deps: { db: unknown }): void {
    mountHonoCrud({
      app: a,
      path: "/api/secrets",
      // biome-ignore lint/suspicious/noExplicitAny: drizzle client is dynamically typed here
      db: deps.db as any,
      table: secretsTable(),
      insertSchema: InsertSchema,
      updateSchema: UpdateSchema,
      dialect: "sqlite",
    });
  }

  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    await seed(client);
    app = new Hono();
    app.use("/api/secrets/*", async (c, next) => {
      if (!c.req.header("authorization")) return c.json({ error: "unauthorized" }, 401);
      await next();
    });
    registerSecretRoutes(app, { db: drizzle(client) });
    app.get("/health", (c) => c.json({ ok: true }));
  });
  afterAll(() => {
    client.close();
  });

  const verbs: ReadonlyArray<[string, string]> = [
    ["GET", "/api/secrets"],
    ["GET", "/api/secrets/1"],
    ["POST", "/api/secrets"],
    ["PATCH", "/api/secrets/1"],
    ["DELETE", "/api/secrets/1"],
  ];

  for (const [method, url] of verbs) {
    test(`${method} ${url} is 401 without the header`, async () => {
      const hasBody = method === "POST" || method === "PATCH";
      const res = await app.request(url, {
        method,
        ...(hasBody
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) }
          : {}),
      });
      expect(res.status).toBe(401);
    });
  }

  test("GET /api/secrets serves the rows once the header is present", async () => {
    const res = await app.request("/api/secrets", { headers: { authorization: "token" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });

  test("a route outside the wildcard stays open", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });
});
