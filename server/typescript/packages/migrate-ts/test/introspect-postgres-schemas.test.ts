/**
 * introspectPostgres — schema-aware scan (Plan 1 Task 5)
 *
 * Verifies that introspectPostgres scans tables from every non-system schema
 * (not just `public`) and attaches the correct `schema` field to each
 * TableDescriptor / ViewDescriptor.
 *
 * pg-mem gap: pg-mem accepts `CREATE SCHEMA foo` and `CREATE TABLE foo.bar (...)`
 * syntactically, but `information_schema.tables` always reports tables as living
 * in `public` regardless of the schema specified at create time. As a result,
 * the "captures tables from non-public schemas" test must run against a real
 * Postgres instance; we gate it on MIGRATE_TS_PG_URL using the same convention
 * as the other PG-gated tests in this package.
 *
 * The "excludes system schemas" test runs against pg-mem (and real PG when
 * MIGRATE_TS_PG_URL is set) — it asserts a negative property that holds in both
 * environments.
 */
import { test, expect, describe } from "bun:test";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { introspectPostgres } from "../src/introspect/postgres.js";

function makePgMemKysely(): Kysely<Record<string, unknown>> {
  const db = newDb();
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();
  return new Kysely({
    dialect: new PostgresDialect({ pool: pool as never }),
  });
}

function makeRealPgKysely(connectionString: string): { kysely: Kysely<Record<string, unknown>>; pool: Pool } {
  const pool = new Pool({ connectionString });
  const kysely = new Kysely<Record<string, unknown>>({
    dialect: new PostgresDialect({ pool }),
  });
  return { kysely, pool };
}

const PG_URL = process.env["MIGRATE_TS_PG_URL"];

describe("introspectPostgres — schema namespacing", () => {
  test("captures tables from non-public schemas with their schema name attached", async () => {
    // Two-layer assertion strategy:
    //  - Against pg-mem (always available): create tables and assert schema field
    //    is populated ("public", since pg-mem collapses all tables to public).
    //    This catches the current bug where TableDescriptor.schema is left
    //    undefined entirely.
    //  - Against real Postgres (when MIGRATE_TS_PG_URL is set): also create a
    //    non-public schema and assert that table's schema is preserved.
    if (!PG_URL) {
      const kysely = makePgMemKysely();
      await sql`CREATE TABLE "Orders" (id bigserial PRIMARY KEY)`.execute(kysely);
      const snapshot = await introspectPostgres(kysely);
      const orders = snapshot.tables.find((t) => t.name === "Orders");
      expect(orders).toBeDefined();
      // pg-mem reports table_schema='public' for all tables.
      expect(orders?.schema).toBe("public");
      return;
    }
    const { kysely, pool } = makeRealPgKysely(PG_URL);
    try {
      await sql`DROP SCHEMA IF EXISTS acme_api CASCADE`.execute(kysely);
      await sql`DROP TABLE IF EXISTS "Orders"`.execute(kysely);
      await sql`CREATE SCHEMA acme_api`.execute(kysely);
      await sql`CREATE TABLE "Orders" (id bigserial PRIMARY KEY)`.execute(kysely);
      await sql`CREATE TABLE acme_api.cases_v1 (id bigserial PRIMARY KEY)`.execute(kysely);

      const snapshot = await introspectPostgres(kysely);

      const orders = snapshot.tables.find((t) => t.name === "Orders");
      expect(orders).toBeDefined();
      expect(orders?.schema).toBe("public");

      const cases = snapshot.tables.find((t) => t.name === "cases_v1");
      expect(cases).toBeDefined();
      expect(cases?.schema).toBe("acme_api");
    } finally {
      await sql`DROP SCHEMA IF EXISTS acme_api CASCADE`.execute(kysely);
      await sql`DROP TABLE IF EXISTS "Orders"`.execute(kysely);
      await pool.end();
    }
  });

  test("excludes system schemas (pg_catalog, information_schema)", async () => {
    // For this test to be a true negative-property check, run it only against
    // real Postgres — that environment actually has pg_catalog and
    // information_schema with thousands of tables/views, so the assertion is
    // load-bearing. pg-mem doesn't expose those system schemas at all, so the
    // assertion would pass trivially there.
    if (!PG_URL) {
      // Run a basic smoke check on pg-mem: snapshot contains at least one
      // schema-tagged table, and none are tagged with system-schema names.
      const kysely = makePgMemKysely();
      await sql`CREATE TABLE smoke_t (id integer)`.execute(kysely);
      const snapshot = await introspectPostgres(kysely);
      const smoke = snapshot.tables.find((t) => t.name === "smoke_t");
      expect(smoke?.schema).toBe("public");
      for (const t of snapshot.tables) {
        expect(t.schema).not.toBe("pg_catalog");
        expect(t.schema).not.toBe("information_schema");
      }
      return;
    }
    const { kysely, pool } = makeRealPgKysely(PG_URL);
    try {
      const snapshot = await introspectPostgres(kysely);
      for (const t of snapshot.tables) {
        expect(t.schema).not.toBe("pg_catalog");
        expect(t.schema).not.toBe("information_schema");
        // No pg_* internal schemas (pg_toast etc.)
        if (t.schema !== undefined) {
          expect(t.schema.startsWith("pg_")).toBe(false);
        }
      }
      for (const v of snapshot.views) {
        expect(v.schema).not.toBe("pg_catalog");
        expect(v.schema).not.toBe("information_schema");
        if (v.schema !== undefined) {
          expect(v.schema.startsWith("pg_")).toBe(false);
        }
      }
    } finally {
      await pool.end();
    }
  });
});
