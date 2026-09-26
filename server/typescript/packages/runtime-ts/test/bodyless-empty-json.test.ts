// An EMPTY body on a method that takes no body is not malformed JSON.
//
// A cold review of 1.0.9-rc.4 found `DELETE /rentals/3` with the header
// `content-type: application/json` and no body answering `400 { "error": "invalid_json" }`.
// HTTP clients commonly send that header on every request (a fetch wrapper that sets it
// globally); Fastify's JSON parser refuses an empty declared-JSON body, and the mounts' new
// route-level handler mapped that to `invalid_json`. GET, DELETE and HEAD carry no body in
// the contract, so an empty one is accepted. An empty body on POST/PUT/PATCH still answers
// `400 { "error": "invalid_json" }` — it IS a body the route needs, and it is not JSON.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Hono } from "hono";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { mountCrudRoutes as mountDrizzleFastify } from "../src/drizzle-fastify/index.js";
import { mountCrudRoutes as mountHono } from "../src/hono/index.js";
import { mountCrudRoutes as mountOmFastify } from "../src/fastify/index.js";
import type { ObjectManager } from "../src/object-manager.js";
import type { FilterAllowlist, SortAllowlist } from "../src/drizzle-fastify/filter-allowlist.js";

const readers = sqliteTable("readers", {
  id:          integer("id").primaryKey({ autoIncrement: true }),
  displayName: text("display_name").notNull(),
});
const InsertSchema = z.object({ displayName: z.string() });
const filterAllowlist: FilterAllowlist = { displayName: { ops: ["eq"], subType: "string", leadingWildcard: false } };
const sortAllowlist: SortAllowlist = { displayName: {} };
const JSON_HEADERS = { "content-type": "application/json" };

let client: Client;
let fastify: FastifyInstance;
let omFastify: FastifyInstance;
let hono: Hono;

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await client.execute(`CREATE TABLE readers (id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT NOT NULL)`);
  for (const n of ["Ann", "Bo", "Cy", "Di", "Ed", "Flo"]) {
    await client.execute({ sql: `INSERT INTO readers (display_name) VALUES (?)`, args: [n] });
  }
  const db = drizzle(client);
  fastify = Fastify();
  mountDrizzleFastify({
    fastify, path: "/readers", db, table: readers,
    insertSchema: InsertSchema, updateSchema: InsertSchema.partial(),
    filterAllowlist, sortAllowlist, dialect: "sqlite",
  });
  await fastify.ready();

  hono = new Hono();
  mountHono({
    app: hono, path: "/readers", db, table: readers,
    insertSchema: InsertSchema, updateSchema: InsertSchema.partial(),
    filterAllowlist, sortAllowlist, dialect: "sqlite",
  });

  const row = { id: 1, displayName: "Ann" };
  const om = {
    findMany: async () => [row], findById: async () => row, create: async () => row,
    update: async () => row, delete: async () => 1, count: async () => 1,
  } as unknown as ObjectManager;
  omFastify = Fastify();
  mountOmFastify({
    fastify: omFastify, path: "/readers", entity: "Reader",
    insertSchema: InsertSchema, updateSchema: InsertSchema.partial(),
    om: async () => om,
  });
  await omFastify.ready();
});

afterAll(async () => {
  await fastify.close();
  await omFastify.close();
  client.close();
});

const BODYLESS = [
  ["GET", "/readers", 200],
  ["GET", "/readers/1", 200],
  ["DELETE", "/readers/2", 204],
] as const;

for (const [label, inject] of [
  ["drizzle-fastify", () => fastify],
  ["fastify (ObjectManager)", () => omFastify],
] as const) {
  describe(`${label} — an empty declared-JSON body on a bodyless method is accepted`, () => {
    for (const [method, url, status] of BODYLESS) {
      test(`${method} ${url}`, async () => {
        const r = await inject().inject({ method, url, headers: JSON_HEADERS, payload: "" });
        expect(r.body).not.toContain("invalid_json");
        expect(r.statusCode).toBe(status);
      });
    }

    test("HEAD /readers", async () => {
      const r = await inject().inject({ method: "HEAD", url: "/readers", headers: JSON_HEADERS, payload: "" });
      expect(r.statusCode).toBe(200);
    });

    for (const method of ["POST", "PATCH", "PUT"] as const) {
      test(`${method} with an empty body still answers 400 invalid_json`, async () => {
        const r = await inject().inject({
          method, url: method === "POST" ? "/readers" : "/readers/1", headers: JSON_HEADERS, payload: "",
        });
        expect(r.statusCode).toBe(400);
        expect(JSON.parse(r.body)).toEqual({ error: "invalid_json" });
      });
    }
  });
}

describe("hono — an empty declared-JSON body on a bodyless method is accepted", () => {
  for (const [method, url, status] of [["GET", "/readers", 200], ["GET", "/readers/1", 200], ["DELETE", "/readers/3", 204]] as const) {
    test(`${method} ${url}`, async () => {
      const res = await hono.request(url, { method, headers: JSON_HEADERS, ...(method === "DELETE" && { body: "" }) });
      expect(res.status).toBe(status);
    });
  }

  for (const method of ["POST", "PATCH", "PUT"] as const) {
    test(`${method} with an empty body still answers 400 invalid_json`, async () => {
      const res = await hono.request(method === "POST" ? "/readers" : "/readers/1", { method, headers: JSON_HEADERS, body: "" });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_json" });
    });
  }
});
