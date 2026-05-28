// Hono parallel of the drizzle-fastify mount-list/filter tests. Asserts
// the cross-port wire shape (envelope, status codes, filter operator
// behavior) is byte-identical to the Fastify flavor.

import { describe, test, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { mountCrudRoutes } from "../../src/hono/index.js";
import type {
  FilterAllowlist,
  SortAllowlist,
} from "../../src/drizzle-fastify/filter-allowlist.js";

const subscribers = sqliteTable("subscribers", {
  id:         integer("id").primaryKey({ autoIncrement: true }),
  email:      text("email").notNull(),
  firstName:  text("first_name").notNull(),
  subscribed: integer("subscribed", { mode: "boolean" }).notNull().default(true),
});

const InsertSchema = z.object({
  email: z.string(),
  firstName: z.string(),
  subscribed: z.boolean().optional(),
});
const UpdateSchema = InsertSchema.partial();

const filterAllowlist: FilterAllowlist = {
  email:      { ops: ["eq", "ne", "in", "like", "isNull"], subType: "string",  leadingWildcard: true },
  firstName:  { ops: ["eq", "ne", "in", "like", "isNull"], subType: "string",  leadingWildcard: false },
  subscribed: { ops: ["eq", "isNull"],                     subType: "boolean", leadingWildcard: false },
};
const sortAllowlist: SortAllowlist = { email: {}, firstName: {} };

let app: Hono;
beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  await client.execute(
    `CREATE TABLE subscribers (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, first_name TEXT NOT NULL, subscribed INTEGER NOT NULL DEFAULT 1)`,
  );
  await client.execute(
    `INSERT INTO subscribers (email, first_name, subscribed) VALUES ('alice@x.com', 'Alice', 1), ('bob@x.com', 'Bob', 0), ('carol@y.com', 'Carol', 1)`,
  );
  const db = drizzle(client);

  app = new Hono();
  mountCrudRoutes({
    app, path: "/subscribers", db, table: subscribers,
    insertSchema: InsertSchema, updateSchema: UpdateSchema,
    filterAllowlist, sortAllowlist, dialect: "sqlite",
  });
});

async function get(url: string): Promise<{ status: number; body: unknown }> {
  const res = await app.request(url);
  const status = res.status;
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  return { status, body };
}

async function post(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await app.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function patch(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await app.request(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function del(url: string): Promise<{ status: number; body: unknown }> {
  const res = await app.request(url, { method: "DELETE" });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("Hono mountCrudRoutes — list", () => {
  test("no filter returns all rows", async () => {
    const r = await get("/subscribers");
    expect(r.status).toBe(200);
    expect((r.body as unknown[]).length).toBe(3);
  });

  test("filter by exact match", async () => {
    const r = await get("/subscribers?filter[firstName]=Alice");
    expect(r.status).toBe(200);
    const rows = r.body as Array<{ firstName: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.firstName).toBe("Alice");
  });

  test("filter by like returns substring matches", async () => {
    const r = await get(
      "/subscribers?filter[email][like]=" + encodeURIComponent("%@x.com"),
    );
    expect(r.status).toBe(200);
    expect((r.body as unknown[]).length).toBe(2);
  });

  test("filter by boolean", async () => {
    const r = await get("/subscribers?filter[subscribed]=true");
    expect(r.status).toBe(200);
    expect((r.body as unknown[]).length).toBe(2);
  });

  test("disallowed op → 400 with structured error", async () => {
    const r = await get("/subscribers?filter[email][gte]=x");
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe("filter.unsupported_op");
  });

  test("like with leading wildcard blocked → 400", async () => {
    const r = await get(
      "/subscribers?filter[firstName][like]=" + encodeURIComponent("%Alice"),
    );
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe("filter.leading_wildcard_disallowed");
  });

  test("unknown filter field → 400", async () => {
    const r = await get("/subscribers?filter[notReal][eq]=x");
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe("filter.unknown_field");
  });

  test("sort asc", async () => {
    const r = await get("/subscribers?sort=firstName:asc");
    expect(r.status).toBe(200);
    const names = (r.body as Array<{ firstName: string }>).map((row) => row.firstName);
    expect(names).toEqual(["Alice", "Bob", "Carol"]);
  });

  test("sort desc", async () => {
    const r = await get("/subscribers?sort=firstName:desc");
    expect(r.status).toBe(200);
    const names = (r.body as Array<{ firstName: string }>).map((row) => row.firstName);
    expect(names).toEqual(["Carol", "Bob", "Alice"]);
  });

  test("limit + offset honored", async () => {
    const r = await get("/subscribers?limit=2&offset=1");
    expect(r.status).toBe(200);
    expect((r.body as unknown[]).length).toBe(2);
  });

  test("withCount=1 returns { rows, total } envelope", async () => {
    const r = await get("/subscribers?withCount=1");
    expect(r.status).toBe(200);
    const body = r.body as { rows: unknown[]; total: number };
    expect(body.rows.length).toBe(3);
    expect(body.total).toBe(3);
  });

  test("withCount=1 + filter — total reflects filtered count, not page", async () => {
    const r = await get("/subscribers?filter[subscribed]=true&withCount=1&limit=1");
    expect(r.status).toBe(200);
    const body = r.body as { rows: unknown[]; total: number };
    expect(body.rows.length).toBe(1);
    expect(body.total).toBe(2);
  });
});

describe("Hono mountCrudRoutes — get / create / update / delete", () => {
  test("get by id — 200 + row", async () => {
    const r = await get("/subscribers/1");
    expect(r.status).toBe(200);
    expect((r.body as { id: number }).id).toBe(1);
  });

  test("get by id — 404 envelope when missing", async () => {
    const r = await get("/subscribers/9999");
    expect(r.status).toBe(404);
    expect((r.body as { error: string }).error).toBe("not_found");
  });

  test("create — 201 on success", async () => {
    const r = await post("/subscribers", { email: "dan@x.com", firstName: "Dan" });
    expect(r.status).toBe(201);
    const row = r.body as { id: number; email: string };
    expect(row.id).toBeGreaterThan(0);
    expect(row.email).toBe("dan@x.com");
  });

  test("create — 400 validation envelope", async () => {
    const r = await post("/subscribers", { firstName: "MissingEmail" });
    expect(r.status).toBe(400);
    const body = r.body as { error: string; issues: unknown[] };
    expect(body.error).toBe("validation");
    expect(Array.isArray(body.issues)).toBe(true);
  });

  test("patch — 200 with updated row", async () => {
    const r = await patch("/subscribers/1", { firstName: "AliceUpdated" });
    expect(r.status).toBe(200);
    expect((r.body as { firstName: string }).firstName).toBe("AliceUpdated");
  });

  test("patch — 404 envelope when missing", async () => {
    const r = await patch("/subscribers/9999", { firstName: "Nope" });
    expect(r.status).toBe(404);
    expect((r.body as { error: string }).error).toBe("not_found");
  });

  test("delete — 204 with empty body", async () => {
    // Create then delete to isolate from other tests.
    const created = await post("/subscribers", { email: "ephemeral@x.com", firstName: "Eph" });
    const id = (created.body as { id: number }).id;
    const res = await app.request(`/subscribers/${id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    const text = await res.text();
    expect(text).toBe("");
  });

  test("delete — 404 envelope when missing", async () => {
    const r = await del("/subscribers/9999");
    expect(r.status).toBe(404);
    expect((r.body as { error: string }).error).toBe("not_found");
  });
});
