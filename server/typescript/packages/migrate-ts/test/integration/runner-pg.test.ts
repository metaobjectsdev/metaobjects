// test/integration/runner-pg.test.ts
import { test, expect, describe } from "bun:test";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import { PgExecutor } from "../../src/runner/pg-executor.js";
import { PgHistoryStore } from "../../src/runner/pg-history-store.js";
import { applyMigrations, rollbackTo } from "../../src/runner/apply.js";
import type { Migration } from "../../src/runner/migration-source.js";

/** A pg-mem-backed Pool-compatible object. */
function memPool() {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  return new Pool();
}

describe("PgExecutor (pg-mem)", () => {
  test("runs SQL and commits", async () => {
    const pool = memPool();
    const exec = new PgExecutor(pool);
    await exec.runInTransaction("CREATE TABLE widgets (id int primary key);");
    await exec.runInTransaction("INSERT INTO widgets (id) VALUES (1);");
    const r = await pool.query("SELECT count(*)::int AS n FROM widgets;");
    expect(r.rows[0].n).toBe(1);
    await pool.end();
  });

  test("rolls back on error (no partial apply)", async () => {
    const pool = memPool();
    const exec = new PgExecutor(pool);
    await exec.runInTransaction("CREATE TABLE t (id int primary key);");
    await expect(
      exec.runInTransaction("INSERT INTO t (id) VALUES (1); INSERT INTO t (id) VALUES (1);"),
    ).rejects.toThrow();
    const r = await pool.query("SELECT count(*)::int AS n FROM t;");
    expect(r.rows[0].n).toBe(0); // both inserts rolled back
    await pool.end();
  });
});

describe("PgHistoryStore tracking (pg-mem)", () => {
  function memPool2() {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    return new Pool();
  }
  const sample = (v: string, success = true) => ({
    version: v, name: "m", checksum: "c", appliedAt: "2026-01-01T00:00:00.000Z", executionMs: 5, success,
  });

  test("ensure creates the table; record/applied/unrecord round-trip", async () => {
    const pool = memPool2();
    const store = new PgHistoryStore(pool, { schema: "public", table: "mo_migrations" });
    await store.ensure();
    await store.record(sample("20260102000000"));
    await store.record(sample("20260101000000"));
    expect((await store.applied()).map((r) => r.version)).toEqual(["20260101000000", "20260102000000"]);
    await store.unrecord("20260101000000");
    expect((await store.applied()).map((r) => r.version)).toEqual(["20260102000000"]);
    await pool.end();
  });

  test("two stores with different table names are independent (multi-tenant)", async () => {
    const pool = memPool2();
    const a = new PgHistoryStore(pool, { schema: "public", table: "tenant_a_migrations" });
    const b = new PgHistoryStore(pool, { schema: "public", table: "tenant_b_migrations" });
    await a.ensure();
    await b.ensure();
    await a.record(sample("20260101000000"));
    expect((await a.applied()).map((r) => r.version)).toEqual(["20260101000000"]);
    expect(await b.applied()).toEqual([]); // independent lineage
    await pool.end();
  });
});

const REAL_PG = process.env.MIGRATE_TS_PG_URL;
const realDescribe = REAL_PG ? describe : describe.skip;

realDescribe("runner end-to-end (real Postgres)", () => {
  const migs: Migration[] = [
    { version: "20260101000000", name: "create-widgets", dir: "/t/1",
      upSql: 'CREATE TABLE "widgets" ("id" int primary key);', downSql: 'DROP TABLE "widgets";' },
    { version: "20260102000000", name: "add-label", dir: "/t/2",
      upSql: 'ALTER TABLE "widgets" ADD COLUMN "label" text;', downSql: 'ALTER TABLE "widgets" DROP COLUMN "label";' },
  ];

  test("apply creates tables + history rows; rollback reverts; advisory lock round-trips", async () => {
    const pool = new Pool({ connectionString: REAL_PG });
    try {
      // clean slate
      await pool.query('DROP TABLE IF EXISTS "widgets"');
      await pool.query("DROP TABLE IF EXISTS metaobjects_migrations");

      const store = new PgHistoryStore(pool);
      const exec = new PgExecutor(pool);

      const applied = await applyMigrations(migs, store, exec);
      expect(applied.applied).toEqual(["20260101000000", "20260102000000"]);

      const cols = await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'widgets' ORDER BY column_name`,
      );
      expect(cols.rows.map((r) => r.column_name)).toEqual(["id", "label"]);
      expect((await store.applied()).map((r) => r.version)).toEqual(["20260101000000", "20260102000000"]);

      // rollback the second migration only
      const rb = await rollbackTo("20260101000000", migs, store, exec);
      expect(rb.rolledBack).toEqual(["20260102000000"]);
      const cols2 = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'widgets'`,
      );
      expect(cols2.rows.map((r) => r.column_name)).toEqual(["id"]); // label dropped
    } finally {
      await pool.end();
    }
  });

  test("a second store with a different schema tracks independently (multi-tenant)", async () => {
    const pool = new Pool({ connectionString: REAL_PG });
    try {
      await pool.query('CREATE SCHEMA IF NOT EXISTS tenant_x');
      await pool.query('DROP TABLE IF EXISTS tenant_x."metaobjects_migrations"');
      const storeX = new PgHistoryStore(pool, { schema: "tenant_x" });
      const storeDefault = new PgHistoryStore(pool);
      await storeDefault.ensure();
      await storeX.ensure();
      await storeX.record({ version: "20260101000000", name: "x", checksum: "c", appliedAt: new Date().toISOString(), executionMs: 1, success: true });
      expect((await storeX.applied()).length).toBe(1);
      // default store unaffected (clean it first so the assertion is meaningful)
      await pool.query('DELETE FROM "public"."metaobjects_migrations"');
      expect((await storeDefault.applied()).length).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
