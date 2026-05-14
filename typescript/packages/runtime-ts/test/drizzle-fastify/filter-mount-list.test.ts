import { describe, test, expect, beforeAll } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { mountCrudRoutes } from "../../src/drizzle-fastify/index.js";
import type { FilterAllowlist, SortAllowlist } from "../../src/drizzle-fastify/filter-allowlist.js";
import { z } from "zod";

const subscribers = sqliteTable("subscribers", {
  id:         integer("id").primaryKey({ autoIncrement: true }),
  email:      text("email").notNull(),
  firstName:  text("first_name").notNull(),
  subscribed: integer("subscribed", { mode: "boolean" }).notNull().default(true),
});

const InsertSchema = z.object({ email: z.string(), firstName: z.string(), subscribed: z.boolean().optional() });
const UpdateSchema = InsertSchema.partial();

const filterAllowlist: FilterAllowlist = {
  email:      { ops: ["eq", "ne", "in", "like", "isNull"], subType: "string",  leadingWildcard: true },
  firstName:  { ops: ["eq", "ne", "in", "like", "isNull"], subType: "string",  leadingWildcard: false },
  subscribed: { ops: ["eq", "isNull"],                     subType: "boolean", leadingWildcard: false },
};
const sortAllowlist: SortAllowlist = { email: {}, firstName: {} };

let app: FastifyInstance;
beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  await client.execute(`CREATE TABLE subscribers (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, first_name TEXT NOT NULL, subscribed INTEGER NOT NULL DEFAULT 1)`);
  await client.execute(`INSERT INTO subscribers (email, first_name, subscribed) VALUES ('alice@x.com', 'Alice', 1), ('bob@x.com', 'Bob', 0), ('carol@y.com', 'Carol', 1)`);
  const db = drizzle(client);

  app = Fastify();
  mountCrudRoutes({
    fastify: app, path: "/subscribers", db, table: subscribers,
    insertSchema: InsertSchema, updateSchema: UpdateSchema,
    filterAllowlist, sortAllowlist, dialect: "sqlite",
  });
  await app.ready();
});

describe("mountListRoute with filter+sort allowlists", () => {
  test("no filter returns all rows", async () => {
    const r = await app.inject({ method: "GET", url: "/subscribers" });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).length).toBe(3);
  });

  test("filter by exact match returns only matching rows", async () => {
    const r = await app.inject({ method: "GET", url: "/subscribers?filter[firstName]=Alice" });
    expect(r.statusCode).toBe(200);
    const rows = JSON.parse(r.body);
    expect(rows.length).toBe(1);
    expect(rows[0].firstName).toBe("Alice");
  });

  test("filter by like returns substring matches", async () => {
    const r = await app.inject({ method: "GET", url: "/subscribers?filter[email][like]=" + encodeURIComponent("%@x.com") });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).length).toBe(2);
  });

  test("filter by boolean", async () => {
    const r = await app.inject({ method: "GET", url: "/subscribers?filter[subscribed]=true" });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).length).toBe(2);
  });

  test("filter on disallowed op → 400 with structured error", async () => {
    const r = await app.inject({ method: "GET", url: "/subscribers?filter[email][gte]=x" });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toBe("filter.unsupported_op");
  });

  test("like with leading wildcard blocked → 400", async () => {
    const r = await app.inject({ method: "GET", url: "/subscribers?filter[firstName][like]=" + encodeURIComponent("%Alice") });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toBe("filter.leading_wildcard_disallowed");
  });

  test("filter on unknown field → 400", async () => {
    const r = await app.inject({ method: "GET", url: "/subscribers?filter[notReal][eq]=x" });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toBe("filter.unknown_field");
  });

  test("sort produces ordered results", async () => {
    const r = await app.inject({ method: "GET", url: "/subscribers?sort=firstName:asc" });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).map((row: any) => row.firstName)).toEqual(["Alice", "Bob", "Carol"]);
  });

  test("sort desc", async () => {
    const r = await app.inject({ method: "GET", url: "/subscribers?sort=firstName:desc" });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).map((row: any) => row.firstName)).toEqual(["Carol", "Bob", "Alice"]);
  });

  test("limit + offset honored", async () => {
    const r = await app.inject({ method: "GET", url: "/subscribers?sort=firstName:asc&limit=1&offset=1" });
    expect(r.statusCode).toBe(200);
    const rows = JSON.parse(r.body);
    expect(rows.length).toBe(1);
    expect(rows[0].firstName).toBe("Bob");
  });
});
