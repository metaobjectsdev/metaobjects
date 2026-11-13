/**
 * `api.unknownFields` at the route. A mount given `knownFields` (what the generated routes pass
 * under `reject`, the default) refuses a create, PUT or PATCH body carrying any other key with
 * `400 { "error": "unknown_fields", "fields": [sorted keys] }` and writes nothing; a declared key
 * the client may not set is still dropped, not refused. A mount given no `knownFields` (`drop`)
 * ignores undeclared keys and writes the rest, as before.
 *
 * Oracle: the contract in docs/features/api-contract.md, "Unknown request fields".
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Hono } from "hono";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { mountCrudRoutes as mountDrizzleFastifyCrud, unknownBodyKeys } from "../src/drizzle-fastify/index.js";
import { mountCrudRoutes as mountHonoCrud } from "../src/hono/index.js";

// `id` is declared but server-generated: known, and never settable.
const KNOWN = ["id", "title"] as const;
const InsertSchema = z.object({ title: z.string() });
const UpdateSchema = InsertSchema.partial();

function itemsTable() {
  return sqliteTable("items", { id: integer("id").primaryKey(), title: text("title").notNull() });
}

async function seeded(): Promise<Client> {
  const client = createClient({ url: ":memory:" });
  await client.execute(`CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL)`);
  await client.execute(`INSERT INTO items (id, title) VALUES (1, 'first')`);
  return client;
}

describe("unknownBodyKeys", () => {
  test("no known list: nothing is unknown", () => {
    expect(unknownBodyKeys({ a: 1, isAdmin: true }, undefined)).toEqual([]);
  });
  test("keys outside the known list, sorted", () => {
    expect(unknownBodyKeys({ title: "x", zeta: 1, isAdmin: true }, KNOWN)).toEqual(["isAdmin", "zeta"]);
  });
  test("a body that is not an object is left to validation", () => {
    expect(unknownBodyKeys([1, 2], KNOWN)).toEqual([]);
    expect(unknownBodyKeys("text", KNOWN)).toEqual([]);
    expect(unknownBodyKeys(null, KNOWN)).toEqual([]);
  });
});

type Send = (method: string, url: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
type Harness = { send: Send; count: () => Promise<number>; close: () => Promise<void> };

function writeBehaviour(name: string, setup: (known: readonly string[] | undefined) => Promise<Harness>) {
  describe(`${name} — reject (knownFields given)`, () => {
    let h: Harness;
    beforeEach(async () => { h = await setup(KNOWN); });
    afterEach(async () => { await h.close(); });

    test("a create with an undeclared key is 400 unknown_fields and writes nothing", async () => {
      const r = await h.send("POST", "/items", { title: "new", isAdmin: true, role: "x" });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "unknown_fields", fields: ["isAdmin", "role"] });
      expect(await h.count()).toBe(1);
    });
    test("PATCH and PUT with an undeclared key are refused and change nothing", async () => {
      for (const method of ["PATCH", "PUT"]) {
        const r = await h.send(method, "/items/1", { title: "changed", isAdmin: true });
        expect(r.status).toBe(400);
        expect(r.body).toEqual({ error: "unknown_fields", fields: ["isAdmin"] });
      }
      const row = await h.send("GET", "/items/1");
      expect((row.body as { title: string }).title).toBe("first");
    });
    test("a declared but server-owned key is dropped, not refused", async () => {
      const r = await h.send("POST", "/items", { id: 99, title: "echoed" });
      expect(r.status).toBe(201);
      expect((r.body as { id: number }).id).not.toBe(99);
    });
  });

  describe(`${name} — drop (no knownFields)`, () => {
    let h: Harness;
    beforeEach(async () => { h = await setup(undefined); });
    afterEach(async () => { await h.close(); });

    test("an undeclared key is ignored and the rest is written", async () => {
      const r = await h.send("POST", "/items", { title: "kept", isAdmin: true });
      expect(r.status).toBe(201);
      expect(r.body).not.toHaveProperty("isAdmin");
      expect(await h.count()).toBe(2);
    });
  });
}

async function countRows(client: Client): Promise<number> {
  const rs = await client.execute("SELECT COUNT(*) AS n FROM items");
  return Number(rs.rows[0]!["n"]);
}

writeBehaviour("drizzle-fastify", async (known) => {
  const client = await seeded();
  const app: FastifyInstance = Fastify();
  mountDrizzleFastifyCrud({
    fastify: app, path: "/items", db: drizzle(client), table: itemsTable(),
    insertSchema: InsertSchema, updateSchema: UpdateSchema,
    ...(known !== undefined ? { knownFields: known } : {}),
  });
  await app.ready();
  return {
    send: async (method, url, body) => {
      const r = await app.inject({ method: method as "GET", url, ...(body !== undefined ? { payload: body as object } : {}) });
      return { status: r.statusCode, body: JSON.parse(r.body) };
    },
    count: () => countRows(client),
    close: async () => { await app.close(); client.close(); },
  };
});

writeBehaviour("hono", async (known) => {
  const client = await seeded();
  const app = new Hono();
  mountHonoCrud({
    app, path: "/items", db: drizzle(client), table: itemsTable(),
    insertSchema: InsertSchema, updateSchema: UpdateSchema,
    ...(known !== undefined ? { knownFields: known } : {}),
  });
  return {
    send: async (method, url, body) => {
      const r = await app.request(url, {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
      });
      return { status: r.status, body: await r.json() };
    },
    count: () => countRows(client),
    close: async () => { client.close(); },
  };
});
