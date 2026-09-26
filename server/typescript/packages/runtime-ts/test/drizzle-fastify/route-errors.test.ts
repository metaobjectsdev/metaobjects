// Error envelopes the drizzle-fastify mounts answer with when something goes wrong
// that is NOT a filter, validation or constraint problem.
//
// A cold review found two leaks, both reproduced against a generated app:
//
//   1. With the schema out of step with the database (a renamed column), every list
//      answered Fastify's default 500 — `{"statusCode":500,…,"message":"Failed query:
//      select \"id\", \"display_name\" … \nparams: …"}` — the query text, the table,
//      the column names and the bound parameter values, to an unauthenticated caller.
//   2. A POST with a malformed JSON body answered Fastify's own
//      `{"statusCode":400,"code":"FST_ERR_CTP_INVALID_JSON_BODY",…}` instead of the
//      contract's `{ "error": "<code>" }` envelope.
//
// Both are now answered by a ROUTE-LEVEL error handler the mounts install on the routes
// they mount — never a global `setErrorHandler`, which would change how an adopter's
// other routes answer.

import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, sqliteView, integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { mountCrudRoutes, mountReadOnlyCrudRoutes, mountM2mRoute } from "../../src/drizzle-fastify/index.js";
import type { FilterAllowlist, SortAllowlist } from "../../src/drizzle-fastify/filter-allowlist.js";

// The Drizzle schema still names `display_name`; the database was renamed underneath it.
const readers = sqliteTable("readers", {
  id:          integer("id").primaryKey({ autoIncrement: true }),
  displayName: text("display_name").notNull(),
});
const readerView = sqliteView("v_readers", {
  id:          integer("id").notNull(),
  displayName: text("display_name").notNull(),
}).existing();
const tags = sqliteTable("tags", {
  id:    integer("id").primaryKey({ autoIncrement: true }),
  label: text("label").notNull(),
});
const readerTags = sqliteTable("reader_tags", {
  readerId: integer("reader_id").notNull(),
  tagId:    integer("tag_id").notNull(),
});

const InsertSchema = z.object({ displayName: z.string() });
const UpdateSchema = InsertSchema.partial();
const filterAllowlist: FilterAllowlist = {
  displayName: { ops: ["eq"], subType: "string", leadingWildcard: false },
};
const sortAllowlist: SortAllowlist = { displayName: {} };

/** Everything a leak would carry: SQL keywords, the table, the column. */
const LEAK = /select|insert|update|delete|readers|display_name|reader_name|params/i;

let client: Client;
let app: FastifyInstance;
let logged: unknown[];
let errorSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await client.execute(`CREATE TABLE readers (id INTEGER PRIMARY KEY AUTOINCREMENT, reader_name TEXT NOT NULL)`);
  await client.execute(`INSERT INTO readers (reader_name) VALUES ('Ann')`);
  await client.execute(`CREATE VIEW v_readers AS SELECT id, reader_name FROM readers`);
  // The junction exists but the tags table does not — the m2m stage-2 read fails.
  await client.execute(`CREATE TABLE reader_tags (reader_id INTEGER NOT NULL, tag_id INTEGER NOT NULL)`);
  await client.execute(`INSERT INTO reader_tags VALUES (1, 1)`);
  const db = drizzle(client);

  app = Fastify();
  mountCrudRoutes({
    fastify: app, path: "/readers", db, table: readers,
    insertSchema: InsertSchema, updateSchema: UpdateSchema,
    filterAllowlist, sortAllowlist, dialect: "sqlite",
  });
  mountReadOnlyCrudRoutes({
    fastify: app, path: "/reader-summaries", db, view: readerView,
    filterAllowlist, sortAllowlist, dialect: "sqlite",
  });
  mountM2mRoute({
    fastify: app, path: "/readers", relationName: "tags", db,
    junctionTable: readerTags, targetTable: tags,
    sourceColumn: "reader_id", targetColumn: "tag_id", symmetric: false,
  });
  // An adopter route OUTSIDE the mounts: its errors must answer exactly as before.
  app.get("/adopter-boom", async () => {
    throw new Error("adopter detail stays adopter business");
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  client.close();
});

function captureLogs(): void {
  logged = [];
  errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args[0]); });
}
function releaseLogs(): void {
  errorSpy.mockRestore();
}

describe("drizzle-fastify — an unexpected error answers 500 { error: \"internal\" } and leaks nothing", () => {
  const cases: Array<{ name: string; method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; url: string; payload?: unknown }> = [
    { name: "list",        method: "GET",    url: "/readers" },
    { name: "get",         method: "GET",    url: "/readers/1" },
    { name: "create",      method: "POST",   url: "/readers", payload: { displayName: "Bo" } },
    { name: "update PATCH", method: "PATCH", url: "/readers/1", payload: { displayName: "Bo" } },
    { name: "update PUT",  method: "PUT",    url: "/readers/1", payload: { displayName: "Bo" } },
    { name: "read-only list", method: "GET", url: "/reader-summaries" },
    { name: "read-only get",  method: "GET", url: "/reader-summaries/1" },
    { name: "m2m traversal",  method: "GET", url: "/readers/1/tags" },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      captureLogs();
      try {
        const r = await app.inject({ method: c.method, url: c.url, ...(c.payload !== undefined && { payload: c.payload }) });
        expect(r.statusCode).toBe(500);
        expect(JSON.parse(r.body)).toEqual({ error: "internal" });
        expect(r.body).not.toMatch(LEAK);
        // The operator keeps the detail: it is logged server-side, once.
        expect(logged.length).toBe(1);
        expect(String((logged[0] as Error).message ?? logged[0])).toMatch(/display_name|tags/);
      } finally {
        releaseLogs();
      }
    });
  }

  test("delete (the DB error path the write mounts already redacted) answers the same envelope", async () => {
    // A DELETE against a table the DB does not have, via a second table const.
    const ghosts = sqliteTable("ghosts", { id: integer("id").primaryKey() });
    const local = Fastify();
    mountCrudRoutes({
      fastify: local, path: "/ghosts", db: drizzle(client), table: ghosts,
      insertSchema: z.object({}), updateSchema: z.object({}),
    });
    await local.ready();
    captureLogs();
    try {
      const r = await local.inject({ method: "DELETE", url: "/ghosts/1" });
      expect(r.statusCode).toBe(500);
      expect(JSON.parse(r.body)).toEqual({ error: "internal" });
      expect(r.body).not.toMatch(/ghosts|delete/i);
      expect(logged.length).toBe(1);
    } finally {
      releaseLogs();
      await local.close();
    }
  });

  test("a route the adopter mounted outside the helpers keeps Fastify's own answer", async () => {
    const r = await app.inject({ method: "GET", url: "/adopter-boom" });
    expect(r.statusCode).toBe(500);
    expect(JSON.parse(r.body).message).toBe("adopter detail stays adopter business");
  });
});

describe("drizzle-fastify — a malformed JSON body answers 400 { error: \"invalid_json\" }", () => {
  for (const [method, url] of [["POST", "/readers"], ["PATCH", "/readers/1"], ["PUT", "/readers/1"]] as const) {
    test(`${method} ${url} with body "not json"`, async () => {
      const r = await app.inject({
        method, url, payload: "not json", headers: { "content-type": "application/json" },
      });
      expect(r.statusCode).toBe(400);
      expect(JSON.parse(r.body)).toEqual({ error: "invalid_json" });
    });
  }

  test("an empty body declared as JSON is malformed too", async () => {
    const r = await app.inject({
      method: "POST", url: "/readers", payload: "", headers: { "content-type": "application/json" },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ error: "invalid_json" });
  });
});

describe("drizzle-fastify — the route-level handler defers to the adopter", () => {
  test("a 4xx an adopter's hook throws still reaches the enclosing scope's handler", async () => {
    const local = Fastify();
    local.setErrorHandler((err: FastifyError, _req, reply) => {
      reply.code(err.statusCode ?? 500).send({ adopter: err.message });
    });
    const unauthorized = Object.assign(new Error("no token"), { statusCode: 401 });
    mountCrudRoutes({
      fastify: local, path: "/readers", db: drizzle(client), table: readers,
      insertSchema: InsertSchema, updateSchema: UpdateSchema,
      routeOptions: { preHandler: async () => { throw unauthorized; } },
    });
    await local.ready();
    const r = await local.inject({ method: "GET", url: "/readers/1" });
    expect(r.statusCode).toBe(401);
    expect(JSON.parse(r.body)).toEqual({ adopter: "no token" });
    await local.close();
  });

  test("an errorHandler passed in routeOptions wins over the mount's own", async () => {
    const local = Fastify();
    mountCrudRoutes({
      fastify: local, path: "/readers", db: drizzle(client), table: readers,
      insertSchema: InsertSchema, updateSchema: UpdateSchema,
      routeOptions: { errorHandler: (_err, _req, reply) => { reply.code(503).send({ mine: true }); } },
    });
    await local.ready();
    const r = await local.inject({ method: "GET", url: "/readers" });
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.body)).toEqual({ mine: true });
    await local.close();
  });
});
