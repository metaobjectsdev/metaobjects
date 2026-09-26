// Hono twin of test/drizzle-fastify/route-errors.test.ts: an unexpected error answers
// `500 { error: "internal" }` with no SQL, table or column in the body; a malformed JSON
// body answers `400 { error: "invalid_json" }`. Scoped to the routes the mounts register —
// the adopter's own routes and `app.onError` keep answering as before.

import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, sqliteView, integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { mountCrudRoutes, mountReadOnlyCrudRoutes } from "../../src/hono/index.js";
import type { FilterAllowlist, SortAllowlist } from "../../src/drizzle-fastify/filter-allowlist.js";

const readers = sqliteTable("readers", {
  id:          integer("id").primaryKey({ autoIncrement: true }),
  displayName: text("display_name").notNull(),
});
const readerView = sqliteView("v_readers", {
  id:          integer("id").notNull(),
  displayName: text("display_name").notNull(),
}).existing();
const InsertSchema = z.object({ displayName: z.string() });
const filterAllowlist: FilterAllowlist = { displayName: { ops: ["eq"], subType: "string", leadingWildcard: false } };
const sortAllowlist: SortAllowlist = { displayName: {} };
const LEAK = /select|insert|update|delete|readers|display_name|reader_name|params/i;

let client: Client;
let app: Hono;

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await client.execute(`CREATE TABLE readers (id INTEGER PRIMARY KEY AUTOINCREMENT, reader_name TEXT NOT NULL)`);
  await client.execute(`INSERT INTO readers (reader_name) VALUES ('Ann')`);
  await client.execute(`CREATE VIEW v_readers AS SELECT id, reader_name FROM readers`);
  const db = drizzle(client);
  app = new Hono();
  mountCrudRoutes({
    app, path: "/readers", db, table: readers,
    insertSchema: InsertSchema, updateSchema: InsertSchema.partial(),
    filterAllowlist, sortAllowlist, dialect: "sqlite",
  });
  mountReadOnlyCrudRoutes({ app, path: "/reader-summaries", db, view: readerView, filterAllowlist, sortAllowlist, dialect: "sqlite" });
  app.get("/adopter-teapot", () => { throw new HTTPException(418, { message: "short and stout" }); });
});

afterAll(() => client.close());

async function call(method: string, url: string, body?: string) {
  const res = await app.request(url, {
    method,
    ...(body !== undefined && { body, headers: { "content-type": "application/json" } }),
  });
  return { status: res.status, text: await res.text() };
}

describe("hono — an unexpected error answers 500 { error: \"internal\" } and leaks nothing", () => {
  const cases: Array<[string, string, string?]> = [
    ["GET", "/readers"],
    ["GET", "/readers/1"],
    ["POST", "/readers", JSON.stringify({ displayName: "Bo" })],
    ["PATCH", "/readers/1", JSON.stringify({ displayName: "Bo" })],
    ["PUT", "/readers/1", JSON.stringify({ displayName: "Bo" })],
    ["GET", "/reader-summaries"],
    ["GET", "/reader-summaries/1"],
  ];
  for (const [method, url, body] of cases) {
    test(`${method} ${url}`, async () => {
      const logged: unknown[] = [];
      const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args[0]); });
      try {
        const r = await call(method, url, body);
        expect(r.status).toBe(500);
        expect(JSON.parse(r.text)).toEqual({ error: "internal" });
        expect(r.text).not.toMatch(LEAK);
        expect(logged.length).toBe(1);
      } finally {
        spy.mockRestore();
      }
    });
  }

  test("DELETE against a table the database does not have", async () => {
    const ghosts = sqliteTable("ghosts", { id: integer("id").primaryKey() });
    const local = new Hono();
    mountCrudRoutes({ app: local, path: "/ghosts", db: drizzle(client), table: ghosts, insertSchema: z.object({}), updateSchema: z.object({}) });
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await local.request("/ghosts/1", { method: "DELETE" });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal" });
    } finally {
      spy.mockRestore();
    }
  });

  test("an HTTPException from an adopter route still reaches Hono's own handling", async () => {
    const r = await call("GET", "/adopter-teapot");
    expect(r.status).toBe(418);
    expect(r.text).toBe("short and stout");
  });
});

describe("hono — a malformed JSON body answers 400 { error: \"invalid_json\" }", () => {
  for (const [method, url] of [["POST", "/readers"], ["PATCH", "/readers/1"], ["PUT", "/readers/1"]] as const) {
    test(`${method} ${url} with body "not json"`, async () => {
      const r = await call(method, url, "not json");
      expect(r.status).toBe(400);
      expect(JSON.parse(r.text)).toEqual({ error: "invalid_json" });
    });
  }
});
