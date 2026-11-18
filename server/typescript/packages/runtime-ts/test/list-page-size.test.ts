/**
 * `api.pagination` at the route: a list with no `?limit=` answers the project's default page
 * size, an explicit `?limit=` above the cap answers 400 `limit_too_large` naming the cap, and a
 * mount given no page size behaves as it always did (the whole table, any `?limit=`).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Hono } from "hono";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import {
  mountCrudRoutes as mountDrizzleFastifyCrud,
  pageLimit,
  ERROR_CODE_LIMIT_TOO_LARGE,
} from "../src/drizzle-fastify/index.js";
import { FilterParseError } from "../src/drizzle-fastify/filter-parser.js";
import { mountCrudRoutes as mountHonoCrud } from "../src/hono/index.js";

const PAGE = { defaultLimit: 2, maxLimit: 4 } as const;
const InsertSchema = z.object({ id: z.number().optional(), title: z.string() });
const UpdateSchema = InsertSchema.partial();

function itemsTable() {
  return sqliteTable("items", { id: integer("id").primaryKey(), title: text("title").notNull() });
}

async function seeded(): Promise<Client> {
  const client = createClient({ url: ":memory:" });
  await client.execute(`CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL)`);
  for (let i = 1; i <= 5; i++) await client.execute(`INSERT INTO items (id, title) VALUES (${i}, 'item ${i}')`);
  return client;
}

describe("pageLimit", () => {
  test("no page size: the request's limit, or none", () => {
    expect(pageLimit(undefined, undefined)).toBeUndefined();
    expect(pageLimit(100000, undefined)).toBe(100000);
  });
  test("no limit: the default page size", () => {
    expect(pageLimit(undefined, PAGE)).toBe(2);
  });
  test("a limit at or under the cap is kept", () => {
    expect(pageLimit(4, PAGE)).toBe(4);
    expect(pageLimit(1, PAGE)).toBe(1);
  });
  test("a limit over the cap throws limit_too_large carrying the cap", () => {
    let caught: unknown;
    try { pageLimit(5, PAGE); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(FilterParseError);
    expect((caught as FilterParseError).code).toBe(ERROR_CODE_LIMIT_TOO_LARGE);
    expect((caught as FilterParseError).details).toEqual({ maxLimit: 4 });
  });
});

type Get = (url: string) => Promise<{ status: number; body: unknown }>;

function listBehaviour(name: string, setup: (pagination: typeof PAGE | undefined) => Promise<{ get: Get; close: () => Promise<void> }>) {
  describe(`${name} — with api.pagination`, () => {
    let h: { get: Get; close: () => Promise<void> };
    beforeAll(async () => { h = await setup(PAGE); });
    afterAll(async () => { await h.close(); });

    test("no ?limit= answers the default page size", async () => {
      const r = await h.get("/items");
      expect(r.status).toBe(200);
      expect((r.body as unknown[]).length).toBe(2);
    });
    test("?limit= at the cap is served", async () => {
      const r = await h.get("/items?limit=4");
      expect((r.body as unknown[]).length).toBe(4);
    });
    test("?limit= over the cap is 400 limit_too_large naming the cap", async () => {
      const r = await h.get("/items?limit=5");
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "limit_too_large", maxLimit: 4 });
    });
    test("offset pages past the default", async () => {
      const r = await h.get("/items?offset=4");
      expect((r.body as Array<{ id: number }>).map((x) => x.id)).toEqual([5]);
    });
    test("withCount reports the full total with the default page", async () => {
      const r = await h.get("/items?withCount=1");
      const body = r.body as { rows: unknown[]; total: number };
      expect(body.rows.length).toBe(2);
      expect(body.total).toBe(5);
    });
  });

  describe(`${name} — without api.pagination`, () => {
    let h: { get: Get; close: () => Promise<void> };
    beforeAll(async () => { h = await setup(undefined); });
    afterAll(async () => { await h.close(); });

    test("no ?limit= answers every row, as before", async () => {
      expect(((await h.get("/items")).body as unknown[]).length).toBe(5);
    });
    test("a large ?limit= is accepted, as before", async () => {
      const r = await h.get("/items?limit=100000");
      expect(r.status).toBe(200);
      expect((r.body as unknown[]).length).toBe(5);
    });
  });
}

listBehaviour("drizzle-fastify", async (pagination) => {
  const client = await seeded();
  const app: FastifyInstance = Fastify();
  mountDrizzleFastifyCrud({
    fastify: app, path: "/items", db: drizzle(client), table: itemsTable(),
    insertSchema: InsertSchema, updateSchema: UpdateSchema,
    ...(pagination !== undefined ? { pagination } : {}),
  });
  await app.ready();
  return {
    get: async (url) => {
      const r = await app.inject({ method: "GET", url });
      return { status: r.statusCode, body: JSON.parse(r.body) };
    },
    close: async () => { await app.close(); client.close(); },
  };
});

listBehaviour("hono", async (pagination) => {
  const client = await seeded();
  const app = new Hono();
  mountHonoCrud({
    app, path: "/items", db: drizzle(client), table: itemsTable(),
    insertSchema: InsertSchema, updateSchema: UpdateSchema,
    ...(pagination !== undefined ? { pagination } : {}),
  });
  return {
    get: async (url) => {
      const r = await app.request(url);
      return { status: r.status, body: await r.json() };
    },
    close: async () => { client.close(); },
  };
});
