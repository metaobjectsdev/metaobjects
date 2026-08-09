/**
 * #286 — the CRUD helpers must work on Postgres, in BOTH adapters.
 *
 * Drizzle's `.all()` and `.get()` are libsql/better-sqlite3-only. The node-postgres
 * builder is thenable but has neither, so calling them 500s every GET with
 * `TypeError: q.all is not a function`. The Fastify adapter was fixed for this and
 * carries a comment explaining it; **Hono was not**, and shipped broken on Postgres
 * through 0.21.2 and 0.21.3. Reported from a real adoption.
 *
 * The reason it survived is the interesting part, and it is what this file exists to
 * close: EVERY adapter test in this package used libsql (`drizzle-orm/libsql`,
 * `:memory:`), where `.all()`/`.get()` exist and work. No test could have caught the
 * incompatibility for either adapter — Fastify's fix was reasoned, not gated. A
 * per-adapter test suite with a single dialect cannot detect a dialect divergence.
 *
 * So this is a MATRIX: the same read paths, asserted across both adapters, against a
 * REAL Postgres. Adding a third adapter should mean adding a row here, not a new file.
 *
 * Gated on METAOBJECTS_TEST_PG_URL (CI's ts-slow lane supplies a Postgres sidecar);
 * skips loudly-but-harmlessly when absent, and the sentinel below fails if a lane
 * claims it intends Postgres and then does not provide it.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, serial, text, boolean } from "drizzle-orm/pg-core";
import { z } from "zod";
import { mountCrudRoutes as mountHono } from "../src/hono/index.js";
import { mountCrudRoutes as mountFastify } from "../src/drizzle-fastify/index.js";
import type { FilterAllowlist, SortAllowlist } from "../src/drizzle-fastify/filter-allowlist.js";

const PG_URL = process.env["METAOBJECTS_TEST_PG_URL"];

const subscribers = pgTable("mo286_subscribers", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  firstName: text("first_name").notNull(),
  subscribed: boolean("subscribed").notNull().default(true),
});

const InsertSchema = z.object({
  email: z.string(),
  firstName: z.string(),
  subscribed: z.boolean().optional(),
});
const UpdateSchema = InsertSchema.partial();

const filterAllowlist: FilterAllowlist = {
  email: { ops: ["eq", "ne", "in", "like", "isNull"], subType: "string", leadingWildcard: true },
  firstName: { ops: ["eq", "ne", "in", "like", "isNull"], subType: "string", leadingWildcard: false },
  subscribed: { ops: ["eq", "isNull"], subType: "boolean", leadingWildcard: false },
};
const sortAllowlist: SortAllowlist = { email: {}, firstName: {} };

describe("real-PG dialect matrix sentinel", () => {
  test("METAOBJECTS_TEST_PG_URL is set when the lane declares RUNTIME_TS_PG_EXPECT=1", () => {
    if (process.env["RUNTIME_TS_PG_EXPECT"] === "1") {
      expect(PG_URL).toBeTruthy();
    }
  });
});

describe("#286 — CRUD helpers on real Postgres, both adapters", () => {
  if (!PG_URL) {
    test.skip("skipped — METAOBJECTS_TEST_PG_URL not set", () => {});
    return;
  }

  let pool: Pool;
  // biome-ignore lint/suspicious/noExplicitAny: drizzle db handle, structurally typed by the mounts
  let db: any;
  let hono: Hono;
  let fastify: FastifyInstance;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    db = drizzle(pool);
    await pool.query(`DROP TABLE IF EXISTS mo286_subscribers`);
    await pool.query(
      `CREATE TABLE mo286_subscribers (
         id serial PRIMARY KEY,
         email text NOT NULL,
         first_name text NOT NULL,
         subscribed boolean NOT NULL DEFAULT true
       )`,
    );
    await pool.query(
      `INSERT INTO mo286_subscribers (email, first_name, subscribed)
       VALUES ('alice@x.com','Alice',true), ('bob@x.com','Bob',false), ('carol@y.com','Carol',true)`,
    );

    hono = new Hono();
    mountHono({
      app: hono, path: "/subscribers", db, table: subscribers,
      insertSchema: InsertSchema, updateSchema: UpdateSchema,
      filterAllowlist, sortAllowlist, dialect: "postgres",
    });

    fastify = Fastify();
    mountFastify({
      fastify, path: "/subscribers", db, table: subscribers,
      insertSchema: InsertSchema, updateSchema: UpdateSchema,
      filterAllowlist, sortAllowlist, dialect: "postgres",
    });
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify?.close();
    await pool.query(`DROP TABLE IF EXISTS mo286_subscribers`);
    await pool.end();
  });

  /** Uniform request surface so the same assertions run against both adapters. */
  const adapters: Array<{ name: string; get: (url: string) => Promise<{ status: number; body: unknown }> }> = [
    {
      name: "hono",
      get: async (url) => {
        const res = await hono.request(url);
        return { status: res.status, body: res.status === 204 ? null : await res.json() };
      },
    },
    {
      name: "fastify",
      get: async (url) => {
        const res = await fastify.inject({ method: "GET", url });
        return { status: res.statusCode, body: res.statusCode === 204 ? null : res.json() };
      },
    },
  ];

  for (const a of adapters) {
    describe(a.name, () => {
      test("list returns rows (the exact call that threw `q.all is not a function`)", async () => {
        const { status, body } = await a.get("/subscribers");
        expect(status).toBe(200);
        expect(Array.isArray(body)).toBe(true);
        expect((body as unknown[]).length).toBe(3);
      });

      test("get-by-id returns one row (the `.get()` path)", async () => {
        const list = (await a.get("/subscribers")).body as Array<{ id: number; email: string }>;
        const target = list.find((r) => r.email === "bob@x.com");
        expect(target).toBeDefined();
        const { status, body } = await a.get(`/subscribers/${target?.id}`);
        expect(status).toBe(200);
        expect((body as { email: string }).email).toBe("bob@x.com");
      });

      test("get-by-id 404s for a missing row rather than throwing", async () => {
        const { status } = await a.get("/subscribers/99999");
        expect(status).toBe(404);
      });

      test("withCount returns the {rows,total} envelope (the count-query `.all()` path)", async () => {
        const { status, body } = await a.get("/subscribers?withCount=1");
        expect(status).toBe(200);
        const env = body as { rows: unknown[]; total: number };
        expect(Array.isArray(env.rows)).toBe(true);
        expect(env.total).toBe(3);
      });

      test("filter + sort execute on Postgres", async () => {
        const { status, body } = await a.get("/subscribers?filter[subscribed]=true&sort=email:desc");
        expect(status).toBe(200);
        const rows = body as Array<{ email: string }>;
        expect(rows.map((r) => r.email)).toEqual(["carol@y.com", "alice@x.com"]);
      });
    });
  }

  test("both adapters return the SAME list payload — the matrix's whole point", async () => {
    const [h, f] = await Promise.all([
      a0().get("/subscribers?sort=email:asc"),
      a1().get("/subscribers?sort=email:asc"),
    ]);
    expect(h.status).toBe(f.status);
    expect(h.body).toEqual(f.body);
  });

  function a0() { return adapters[0]!; }
  function a1() { return adapters[1]!; }
});
