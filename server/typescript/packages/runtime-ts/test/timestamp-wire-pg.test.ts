/**
 * A field.timestamp reaches the wire as ISO 8601 — on a REAL Postgres, through every
 * mount the generated routes delegate to, in both adapters and both entry points.
 *
 * The defect this closes shipped because nothing could see it. Codegen maps a Postgres
 * field.timestamp to `timestamp(…, { mode: "string" })`; in string mode Drizzle returns
 * the text node-postgres received, which is Postgres' OUTPUT format rendered in the
 * SESSION time zone — `2026-09-20 12:00:00+00`, not `2026-09-20T12:00:00Z`. The
 * api-contract runners normalize `createdAt` before comparing, and every other adapter
 * test here runs on libsql, which has no timestamp type at all. An adopter's strict
 * ISO 8601 client was the first thing to disagree.
 *
 * The session runs in America/New_York on purpose: under UTC, relabelling `+00` as `Z`
 * would pass, and a mount that never converted an offset would look correct.
 *
 * Gated on METAOBJECTS_TEST_PG_URL, like `dialect-matrix-pg.test.ts`.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { integer, pgTable, pgView, serial, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod";
import * as honoSrc from "../src/hono/index.js";
import * as fastifySrc from "../src/drizzle-fastify/index.js";

const PG_URL = process.env["METAOBJECTS_TEST_PG_URL"];

const events = pgTable("mo_tswire_events", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  at: timestamp("at", { mode: "string", withTimezone: true }),
  wallClock: timestamp("wall_clock", { mode: "string", withTimezone: false }),
  atDate: timestamp("at_date", { mode: "date", withTimezone: true }),
  wallDate: timestamp("wall_date", { mode: "date", withTimezone: false }),
});

const eventsView = pgView("mo_tswire_events_v", {
  id: integer("id").notNull(),
  name: text("name").notNull(),
  at: timestamp("at", { mode: "string", withTimezone: true }),
  wallClock: timestamp("wall_clock", { mode: "string", withTimezone: false }),
}).existing();

const ownerEvents = pgTable("mo_tswire_owner_events", {
  ownerId: integer("owner_id").notNull(),
  eventId: integer("event_id").notNull(),
});

const InsertSchema = z.object({
  name: z.string(),
  at: z.string().nullable().optional(),
  wallClock: z.string().nullable().optional(),
  atDate: z.coerce.date().nullable().optional(),
  wallDate: z.coerce.date().nullable().optional(),
});
const UpdateSchema = InsertSchema.partial();

/** What every read of the POSTed row must answer, whichever mount serves it. */
const CANONICAL = {
  at: "2026-03-04T05:06:07.12Z",
  wallClock: "2026-03-04T07:06:07.12",
  atDate: "2026-03-04T05:06:07.12Z",
  wallDate: "2026-03-04T07:06:07.12",
};
const VIEW_CANONICAL = { at: CANONICAL.at, wallClock: CANONICAL.wallClock };

describe("field.timestamp wire spelling on real Postgres", () => {
  if (!PG_URL) {
    test.skip("skipped — METAOBJECTS_TEST_PG_URL not set", () => {});
    return;
  }

  type Res = Promise<{ status: number; body: unknown }>;
  type Call = (method: "GET" | "POST" | "PATCH", url: string, payload?: Record<string, unknown>) => Res;
  const adapters = new Map<string, Call>();
  const ADAPTER_NAMES = ["hono (src)", "fastify (src)", "hono (dist)", "fastify (dist)"] as const;
  const use = (name: string): Call => {
    const a = adapters.get(name);
    if (!a) throw new Error(`adapter row [${name}] was never mounted — the matrix is incomplete`);
    return a;
  };

  let pool: Pool;
  const fastifies: FastifyInstance[] = [];
  let builtTreeMissing = false;
  let ownerId = 0;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL, options: "-c TimeZone=America/New_York" });
    const db = drizzle(pool);
    await pool.query(`DROP VIEW IF EXISTS mo_tswire_events_v`);
    await pool.query(`DROP TABLE IF EXISTS mo_tswire_owner_events, mo_tswire_events`);
    await pool.query(
      `CREATE TABLE mo_tswire_events (
         id serial PRIMARY KEY,
         name text NOT NULL,
         at timestamptz,
         wall_clock timestamp,
         at_date timestamptz,
         wall_date timestamp
       )`,
    );
    await pool.query(`CREATE VIEW mo_tswire_events_v AS SELECT id, name, at, wall_clock FROM mo_tswire_events`);
    await pool.query(`CREATE TABLE mo_tswire_owner_events (owner_id integer NOT NULL, event_id integer NOT NULL)`);

    const entries: Array<{ tree: string; hono: typeof honoSrc; fastify: typeof fastifySrc }> = [
      { tree: "src", hono: honoSrc, fastify: fastifySrc },
    ];
    if (existsSync(join(import.meta.dir, "..", "dist", "hono", "index.js"))) {
      entries.push({
        tree: "dist",
        hono: await import("../dist/hono/index.js"),
        fastify: await import("../dist/drizzle-fastify/index.js"),
      });
    } else {
      builtTreeMissing = true;
    }

    for (const e of entries) {
      const h = new Hono();
      e.hono.mountCrudRoutes({ app: h, path: "/events", db, table: events, insertSchema: InsertSchema, updateSchema: UpdateSchema });
      e.hono.mountReadOnlyCrudRoutes({ app: h, path: "/event-views", db, view: eventsView, filterAllowlist: {}, sortAllowlist: {}, dialect: "postgres" });

      const f = Fastify();
      e.fastify.mountCrudRoutes({ fastify: f, path: "/events", db, table: events, insertSchema: InsertSchema, updateSchema: UpdateSchema });
      e.fastify.mountReadOnlyCrudRoutes({ fastify: f, path: "/event-views", db, view: eventsView, filterAllowlist: {}, sortAllowlist: {}, dialect: "postgres" });
      e.fastify.mountM2mRoute({
        fastify: f, path: "/owners", relationName: "events", db,
        junctionTable: ownerEvents, targetTable: events,
        sourceColumn: "owner_id", targetColumn: "event_id", symmetric: false,
      });
      await f.ready();
      fastifies.push(f);

      adapters.set(`hono (${e.tree})`, async (method, url, payload) => {
        const res = await h.request(url, {
          method,
          ...(payload === undefined ? {} : { body: JSON.stringify(payload), headers: { "content-type": "application/json" } }),
        });
        return { status: res.status, body: await res.json() };
      });
      adapters.set(`fastify (${e.tree})`, async (method, url, payload) => {
        const res = payload === undefined ? await f.inject({ method, url }) : await f.inject({ method, url, payload });
        return { status: res.statusCode, body: res.json() };
      });
    }
  });

  afterAll(async () => {
    for (const f of fastifies) await f.close();
    await pool.query(`DROP VIEW IF EXISTS mo_tswire_events_v`);
    await pool.query(`DROP TABLE IF EXISTS mo_tswire_owner_events, mo_tswire_events`);
    await pool.end();
  });

  test("the BUILT tree is present, so Node's entry point is actually covered", () => {
    expect(builtTreeMissing).toBe(false);
    expect([...adapters.keys()].sort()).toEqual(["fastify (dist)", "fastify (src)", "hono (dist)", "hono (src)"]);
  });

  for (const a of ADAPTER_NAMES) {
    describe(a, () => {
      let id = 0;

      test("create answers canonical timestamps — an offset converted to UTC, a wall clock kept", async () => {
        const created = await use(a)("POST", "/events", {
          name: `create ${a}`,
          at: "2026-03-04T07:06:07.120+02:00",
          wallClock: "2026-03-04T07:06:07.120",
          atDate: "2026-03-04T05:06:07.120Z",
          wallDate: "2026-03-04T07:06:07.120Z",
        });
        expect(created.status).toBe(201);
        id = (created.body as { id: number }).id;
        expect(created.body).toMatchObject(CANONICAL);
      });

      test("get-by-id reads the same spelling back", async () => {
        const got = await use(a)("GET", `/events/${id}`);
        expect(got.status).toBe(200);
        expect(got.body).toMatchObject(CANONICAL);
      });

      test("list and the withCount envelope canonicalize every row", async () => {
        const list = (await use(a)("GET", "/events")).body as Array<{ id: number }>;
        expect(list.find((r) => r.id === id)).toMatchObject(CANONICAL);
        const env = (await use(a)("GET", "/events?withCount=1")).body as { rows: Array<{ id: number }> };
        expect(env.rows.find((r) => r.id === id)).toMatchObject(CANONICAL);
      });

      test("update truncates microseconds to milliseconds", async () => {
        const patched = await use(a)("PATCH", `/events/${id}`, { at: "2026-03-04T05:06:07.123456Z" });
        expect(patched.status).toBe(200);
        expect(patched.body).toMatchObject({ ...CANONICAL, at: "2026-03-04T05:06:07.123Z" });
        await use(a)("PATCH", `/events/${id}`, { at: "2026-03-04T07:06:07.120+02:00" });
      });

      test("an update that strips to nothing still answers canonical timestamps", async () => {
        const noop = await use(a)("PATCH", `/events/${id}`, {});
        expect(noop.status).toBe(200);
        expect(noop.body).toMatchObject(CANONICAL);
      });

      test("a read-only (projection) mount canonicalizes its view's columns", async () => {
        const list = (await use(a)("GET", "/event-views")).body as Array<{ id: number }>;
        expect(list.find((r) => r.id === id)).toMatchObject(VIEW_CANONICAL);
        const env = (await use(a)("GET", "/event-views?withCount=1")).body as { rows: Array<{ id: number }> };
        expect(env.rows.find((r) => r.id === id)).toMatchObject(VIEW_CANONICAL);
        const got = await use(a)("GET", `/event-views/${id}`);
        expect(got.status).toBe(200);
        expect(got.body).toMatchObject(VIEW_CANONICAL);
      });

      if (a.startsWith("fastify")) {
        test("an M:N traversal canonicalizes the target rows", async () => {
          ownerId += 1;
          await pool.query(`INSERT INTO mo_tswire_owner_events (owner_id, event_id) VALUES ($1, $2)`, [ownerId, id]);
          const related = await use(a)("GET", `/owners/${ownerId}/events`);
          expect(related.status).toBe(200);
          expect(related.body).toEqual([expect.objectContaining({ id, ...CANONICAL })]);
        });
      }
    });
  }
});
