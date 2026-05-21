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

  test("returns a bare array when withCount is absent (unchanged contract)", async () => {
    const r = await app.inject({ method: "GET", url: "/subscribers?limit=10" });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(Array.isArray(body)).toBe(true);
  });

  test("returns { rows, total } when withCount=1, total reflects the full filtered set", async () => {
    const r = await app.inject({ method: "GET", url: "/subscribers?limit=2&withCount=1" });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { rows: unknown[]; total: number };
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows.length).toBeLessThanOrEqual(2);
    expect(typeof body.total).toBe("number");
    expect(body.total).toBeGreaterThanOrEqual(body.rows.length);
  });

  test("total respects the filter — counts the filtered set, not the table", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/subscribers?filter[subscribed][eq]=true&limit=1&withCount=1",
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { rows: unknown[]; total: number };
    // 2 subscribers are subscribed (Alice + Carol); total should reflect the filtered count
    expect(body.total).toBe(2);
    // Only 1 row returned due to limit=1
    expect(body.rows.length).toBe(1);
  });

  test("?search=term ORs like('%term%') across @filterable string fields", async () => {
    // "alice" appears in alice@x.com (email field) — exactly 1 subscriber matches
    const r = await app.inject({
      method: "GET",
      url: "/subscribers?search=alice&withCount=1",
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { rows: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(1);
    expect((body.rows[0] as { email: string }).email).toBe("alice@x.com");
  });

  test("search does NOT match against non-string filterable fields", async () => {
    // "true" does not appear as a substring in any email or firstName —
    // the boolean `subscribed` field is excluded because its subType is not "string"
    const r = await app.inject({
      method: "GET",
      url: "/subscribers?search=true&withCount=1",
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { rows: unknown[]; total: number };
    expect(body.total).toBe(0);
  });

  test("search combines with explicit filter as AND (not OR)", async () => {
    // search="@y.com" matches carol@y.com (1 row: Carol, subscribed=true)
    // filter[subscribed][eq]=false matches only Bob (subscribed=false)
    // AND-combination yields intersection = 0 rows
    const r = await app.inject({
      method: "GET",
      url: "/subscribers?search=%40y.com&filter[subscribed][eq]=false&withCount=1",
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { rows: unknown[]; total: number };
    expect(body.total).toBe(0);
  });

  test("empty/absent search is a no-op", async () => {
    const a = await app.inject({ method: "GET", url: "/subscribers?withCount=1" });
    const b = await app.inject({ method: "GET", url: "/subscribers?search=&withCount=1" });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect((JSON.parse(a.body) as { total: number }).total).toBe(
      (JSON.parse(b.body) as { total: number }).total,
    );
  });
});
