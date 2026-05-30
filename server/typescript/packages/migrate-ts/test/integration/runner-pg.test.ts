// test/integration/runner-pg.test.ts
import { test, expect, describe } from "bun:test";
import { newDb } from "pg-mem";
import { PgExecutor } from "../../src/runner/pg-executor.js";
import { PgHistoryStore } from "../../src/runner/pg-history-store.js";

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
