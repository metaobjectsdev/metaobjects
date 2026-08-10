// The read-only mounts' RAW-SQL branch, on real Postgres, through BOTH adapters.
//
// `mountReadOnlyCrudRoutes` called `db.all(sql.raw(...))` — `.all()` on the top-level
// db HANDLE, which is the libsql raw-exec API. `PgDatabase` does not implement it at
// all, so an opaque `@sql` view (the ADR-0043 escape hatch, where the view declares no
// columns and `useRawSql` is therefore true) 500'd on Postgres in exactly the way
// `mountCrudRoutes` did before #286 — in BOTH adapters, including Fastify, which was
// the correct reference for the OTHER `.all()` shape.
//
// Why it survived the #286 sweep: that hunt was for `.all()` on a query BUILDER, and
// awaiting the thenable fixed every one of those on both dialects. This is a different
// shape needing a real dialect dispatch, and it sat two lines below a comment
// explaining that `.all()` is libsql-only. Found by an adopting project's code review.
//
// Why no test caught it: the read-only path had NO Postgres coverage at all — the
// dialect matrix added in 0.21.5 covers `mountCrudRoutes` only, and the existing
// read-only tests are libsql/:memory:, where `db.all()` happens to exist.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgView } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { Hono } from "hono";
import { mountReadOnlyCrudRoutes as mountHonoRO } from "../src/hono/mount-read-only.js";
import { mountReadOnlyCrudRoutes as mountFastifyRO } from "../src/drizzle-fastify/mount-read-only.js";

const PG_URL = process.env.METAOBJECTS_TEST_PG_URL;
const VIEW = "mo_ro_raw_authors_v";

// An OPAQUE view: an EMPTY column map is precisely what isEmptyColumnView() keys on
// (selectedFields present but zero-length), routing both mounts down the raw-SQL
// branch. Declaring columns here would silently take the query-builder path instead
// and test nothing — the failure mode this whole file exists to prevent.
const opaqueView = pgView(VIEW, {}).existing();

describe.skipIf(!PG_URL)("read-only raw-SQL branch on real Postgres", () => {
  let pool: Pool;
  // biome-ignore lint/suspicious/noExplicitAny: drizzle db handle
  let db: any;
  let hono: Hono;
  let fastify: FastifyInstance;
  const adapters: Array<{ name: string; get: (url: string) => Promise<{ status: number; body: unknown }> }> = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    db = drizzle(pool);
    await pool.query(`DROP VIEW IF EXISTS ${VIEW}`);
    await pool.query(`DROP TABLE IF EXISTS mo_ro_raw_authors`);
    await pool.query(`CREATE TABLE mo_ro_raw_authors (id serial PRIMARY KEY, full_name text NOT NULL)`);
    await pool.query(`INSERT INTO mo_ro_raw_authors (full_name) VALUES ('Ada'), ('Alan'), ('Grace')`);
    await pool.query(`CREATE VIEW ${VIEW} AS SELECT id, full_name FROM mo_ro_raw_authors`);

    // Empty allowlists: the raw-SQL branch bypasses the filter parser entirely, so
    // there is nothing here for them to gate — but the options type requires them.
    const allow = { fields: {} } as never;
    hono = new Hono();
    mountHonoRO({ app: hono, path: "/authors", db, view: opaqueView, dialect: "postgres",
      filterAllowlist: allow, sortAllowlist: allow });
    fastify = Fastify();
    mountFastifyRO({ fastify, path: "/authors", db, view: opaqueView, dialect: "postgres",
      filterAllowlist: allow, sortAllowlist: allow });
    await fastify.ready();

    adapters.push(
      { name: "hono", get: async (url) => {
        const res = await hono.request(url);
        return { status: res.status, body: res.status === 204 ? null : await res.json() };
      } },
      { name: "fastify", get: async (url) => {
        const res = await fastify.inject({ method: "GET", url });
        return { status: res.statusCode, body: res.statusCode === 204 ? null : res.json() };
      } },
    );
  });

  afterAll(async () => {
    await fastify?.close();
    await pool.query(`DROP VIEW IF EXISTS ${VIEW}`);
    await pool.query(`DROP TABLE IF EXISTS mo_ro_raw_authors`);
    await pool.end();
  });

  test("the sentinel: this suite is armed when the lane declares a Postgres URL", () => {
    if (process.env.RUNTIME_TS_PG_EXPECT === "1") expect(PG_URL).toBeTruthy();
  });

  for (const name of ["hono", "fastify"]) {
    describe(name, () => {
      const use = () => {
        const a = adapters.find((x) => x.name === name);
        if (!a) throw new Error(`adapter [${name}] never mounted — the matrix is incomplete`);
        return a;
      };

      test("list over an opaque view returns rows (the db.all(sql.raw(...)) path)", async () => {
        const { status, body } = await use().get("/authors");
        expect(status).toBe(200);
        const rows = body as Array<{ fullName: string }>;
        expect(rows.length).toBe(3);
        // Raw rows are snake_case from the engine; the mount camelizes them.
        expect(rows.map((r) => r.fullName).sort()).toEqual(["Ada", "Alan", "Grace"]);
      });

      test("withCount returns the envelope (the raw COUNT(*) path)", async () => {
        const { status, body } = await use().get("/authors?withCount=1");
        expect(status).toBe(200);
        const env = body as { rows: unknown[]; total: number };
        expect(env.total).toBe(3);
        expect(env.rows.length).toBe(3);
      });

      test("get-by-id returns one row (the raw WHERE path)", async () => {
        const list = (await use().get("/authors")).body as Array<{ id: number; fullName: string }>;
        const target = list.find((r) => r.fullName === "Alan")!;
        const { status, body } = await use().get(`/authors/${target.id}`);
        expect(status).toBe(200);
        expect((body as { fullName: string }).fullName).toBe("Alan");
      });

      test("get-by-id 404s for a missing row rather than throwing", async () => {
        expect((await use().get("/authors/99999")).status).toBe(404);
      });
    });
  }
});
