// test/integration/runner-pg.test.ts
import { test, expect, describe } from "bun:test";
import { newDb } from "pg-mem";
import { PgExecutor } from "../../src/runner/pg-executor.js";

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
