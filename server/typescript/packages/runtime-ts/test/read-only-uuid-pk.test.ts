/**
 * The read-only mounts' GET-by-id route coerced the path param through `Number(id)`
 * unconditionally, with no reference to the PK's actual type. For any projection whose
 * identity is a UUID/string — the common case whenever `identity: "uuid"` is the
 * project's standard PK — `Number(id)` is NaN, `eq(col, NaN)` matches nothing, and the
 * endpoint returns 404 for every id that genuinely exists. The row is visible in the
 * SAME projection's list response; only its own detail route can never find it.
 *
 * This is a server-side runtime bug (a silently wrong HTTP status), not merely a
 * generated-type annoyance. It affected BOTH mounts: hono AND drizzle-fastify.
 *
 * Reported by a downstream consumer against 0.15.20.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Hono } from "hono";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteView, integer, text } from "drizzle-orm/sqlite-core";
import { mountReadOnlyCrudRoutes } from "../src/drizzle-fastify/mount-read-only.js";
import { mountReadOnlyCrudRoutes as mountHonoReadOnly } from "../src/hono/mount-read-only.js";
import type { FilterAllowlist, SortAllowlist } from "../src/drizzle-fastify/filter-allowlist.js";

const UUID = "292cba00-1e4f-4c78-bf89-e72971fb1e5d";
const filterAllowlist: FilterAllowlist = {
  title: { ops: ["eq"], subType: "string", leadingWildcard: false },
};
const sortAllowlist: SortAllowlist = { id: { defaultOrder: "asc" } };

describe("read-only GET-by-id — non-numeric (uuid) primary key", () => {
  let client: ReturnType<typeof createClient>;
  let fastify: FastifyInstance;
  let hono: Hono;
  // numeric-PK view, to prove we don't regress the integer case
  let numericFastify: FastifyInstance;

  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    await client.execute(`CREATE TABLE trips (id TEXT PRIMARY KEY, title TEXT NOT NULL);`);
    await client.execute(`CREATE VIEW v_trip_summary AS SELECT id, title FROM trips;`);
    await client.execute(`INSERT INTO trips (id, title) VALUES ('${UUID}', 'Iceland');`);
    await client.execute(`CREATE TABLE programs (id INTEGER PRIMARY KEY, title TEXT NOT NULL);`);
    await client.execute(`CREATE VIEW v_program_summary AS SELECT id, title FROM programs;`);
    await client.execute(`INSERT INTO programs (id, title) VALUES (1, 'Alpha');`);

    const db = drizzle(client);
    const uuidView = sqliteView("v_trip_summary", {
      id: text("id").notNull(),
      title: text("title").notNull(),
    }).existing();
    const numericView = sqliteView("v_program_summary", {
      id: integer("id").notNull(),
      title: text("title").notNull(),
    }).existing();

    fastify = Fastify();
    mountReadOnlyCrudRoutes({
      fastify, path: "/trip-summaries", db, view: uuidView,
      filterAllowlist, sortAllowlist, dialect: "sqlite",
    });
    await fastify.ready();

    numericFastify = Fastify();
    mountReadOnlyCrudRoutes({
      fastify: numericFastify, path: "/program-summaries", db, view: numericView,
      filterAllowlist, sortAllowlist, dialect: "sqlite",
    });
    await numericFastify.ready();

    hono = new Hono();
    mountHonoReadOnly({
      app: hono, path: "/trip-summaries", db, view: uuidView,
      filterAllowlist, sortAllowlist, dialect: "sqlite",
    });
  });

  afterAll(async () => {
    await fastify.close();
    await numericFastify.close();
    client.close();
  });

  test("fastify: the row IS visible in the list (so it unquestionably exists)", async () => {
    const res = await fastify.inject({ method: "GET", url: "/trip-summaries" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)[0].id).toBe(UUID);
  });

  test("fastify: GET /trip-summaries/:uuid finds the row (was 404 — Number(uuid) is NaN)", async () => {
    const res = await fastify.inject({ method: "GET", url: `/trip-summaries/${UUID}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).title).toBe("Iceland");
  });

  test("hono: GET /trip-summaries/:uuid finds the row", async () => {
    const res = await hono.request(`/trip-summaries/${UUID}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { title: string }).title).toBe("Iceland");
  });

  test("a genuinely absent uuid still 404s", async () => {
    const res = await fastify.inject({
      method: "GET", url: "/trip-summaries/00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(404);
  });

  test("regression guard: a numeric PK still resolves by id", async () => {
    const res = await numericFastify.inject({ method: "GET", url: "/program-summaries/1" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).title).toBe("Alpha");
  });
});
