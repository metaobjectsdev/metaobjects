import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { applyPending, rollbackTo } from "../../src/apply/apply.js";
import { appliedNames } from "../../src/apply/ledger.js";

function writeMig(root: string, name: string, up: string, down: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "up.sql"), up, "utf8");
  writeFileSync(join(dir, "down.sql"), down, "utf8");
}

async function tableExists(db: Kysely<Record<string, unknown>>, name: string): Promise<boolean> {
  const rows = await sql<{ c: number }>`
    SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name=${name}
  `.execute(db);
  return (rows.rows[0]?.c ?? 0) > 0;
}

describe("rollbackTo — down.sql, reverse order, ledger unrecord (sqlite)", () => {
  let db: Kysely<Record<string, unknown>>;
  let tmp: string;
  let migDir: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "rollback-test-"));
    migDir = join(tmp, "migrations");
    mkdirSync(migDir, { recursive: true });
    db = new Kysely<Record<string, unknown>>({
      dialect: new LibsqlDialect({ url: `file:${join(tmp, "test.db")}` }),
    });
  });
  afterEach(async () => {
    await db.destroy();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("rolls back migrations newer than target, in reverse order; target retained", async () => {
    writeMig(migDir, "20260101000000-a", "CREATE TABLE a (id INTEGER PRIMARY KEY);", "DROP TABLE a;");
    writeMig(migDir, "20260102000000-b", "CREATE TABLE b (id INTEGER PRIMARY KEY);", "DROP TABLE b;");
    writeMig(migDir, "20260103000000-c", "CREATE TABLE c (id INTEGER PRIMARY KEY);", "DROP TABLE c;");
    await applyPending(db, migDir, { dryRun: false });

    const result = await rollbackTo(db, migDir, "20260101000000-a", {});
    // Newest-first: c then b. a is the target → retained.
    expect(result.rolledBack).toEqual(["20260103000000-c", "20260102000000-b"]);

    expect(await tableExists(db, "a")).toBe(true);
    expect(await tableExists(db, "b")).toBe(false);
    expect(await tableExists(db, "c")).toBe(false);

    const names = await appliedNames(db);
    expect([...names]).toEqual(["20260101000000-a"]);
  });

  test("target=null rolls back everything", async () => {
    writeMig(migDir, "20260101000000-a", "CREATE TABLE a (id INTEGER PRIMARY KEY);", "DROP TABLE a;");
    writeMig(migDir, "20260102000000-b", "CREATE TABLE b (id INTEGER PRIMARY KEY);", "DROP TABLE b;");
    await applyPending(db, migDir, { dryRun: false });

    const result = await rollbackTo(db, migDir, null, {});
    expect(result.rolledBack).toEqual(["20260102000000-b", "20260101000000-a"]);
    expect(await tableExists(db, "a")).toBe(false);
    expect(await tableExists(db, "b")).toBe(false);
    expect((await appliedNames(db)).size).toBe(0);
  });

  test("empty/whitespace-only down.sql THROWS (data-migration downs are hand-authored)", async () => {
    writeMig(migDir, "20260101000000-a", "CREATE TABLE a (id INTEGER PRIMARY KEY);", "DROP TABLE a;");
    writeMig(migDir, "20260102000000-b", "CREATE TABLE b (id INTEGER PRIMARY KEY);", "   \n  ");
    await applyPending(db, migDir, { dryRun: false });

    await expect(rollbackTo(db, migDir, "20260101000000-a", {})).rejects.toThrow(/down\.sql is empty/i);
    // b's down threw before unrecording — it stays in the ledger.
    expect((await appliedNames(db)).has("20260102000000-b")).toBe(true);
  });

  test("MISSING down.sql throws a 'not found' error — distinct from empty content", async () => {
    // Create the migration dir + up.sql but DELIBERATELY no down.sql file.
    const dir = join(migDir, "20260101000000-nodown");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "up.sql"), "CREATE TABLE a (id INTEGER PRIMARY KEY);", "utf8");
    await applyPending(db, migDir, { dryRun: false });

    // Missing file → the 'not found' message, NOT the 'is empty' message.
    await expect(rollbackTo(db, migDir, null, {})).rejects.toThrow(/down\.sql not found/i);
    await expect(rollbackTo(db, migDir, null, {})).rejects.not.toThrow(/down\.sql is empty/i);
    // Threw before unrecording — it stays applied.
    expect((await appliedNames(db)).has("20260101000000-nodown")).toBe(true);
  });

  test("multi-statement down.sql is split and run (splitter reuse)", async () => {
    writeMig(
      migDir,
      "20260101000000-seed",
      "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);\nINSERT INTO t (id, name) VALUES (1, 'x;y');",
      "DELETE FROM t WHERE id=1;\nDROP TABLE t;",
    );
    await applyPending(db, migDir, { dryRun: false });
    expect(await tableExists(db, "t")).toBe(true);

    const result = await rollbackTo(db, migDir, null, {});
    expect(result.rolledBack).toEqual(["20260101000000-seed"]);
    expect(await tableExists(db, "t")).toBe(false);
  });

  test("no applied migrations → empty rollback", async () => {
    const result = await rollbackTo(db, migDir, null, {});
    expect(result.rolledBack).toEqual([]);
  });

  test("a failing down statement rolls back that migration's tx and STOPS the chain", async () => {
    // Each down runs in its own transaction (down SQL + ledger delete together).
    // Rolling back to "a" processes c (succeeds) then b (fails). b's down drops b
    // then hits a bad statement → the WHOLE tx rolls back: b is NOT dropped and
    // its ledger row survives, and the error stops the chain (a is never touched).
    writeMig(migDir, "20260101000000-a", "CREATE TABLE a (id INTEGER PRIMARY KEY);", "DROP TABLE a;");
    writeMig(migDir, "20260102000000-b", "CREATE TABLE b (id INTEGER PRIMARY KEY);", "DROP TABLE b;\nDROP TABLE nonexistent_xyz;");
    writeMig(migDir, "20260103000000-c", "CREATE TABLE c (id INTEGER PRIMARY KEY);", "DROP TABLE c;");
    await applyPending(db, migDir, { dryRun: false });

    await expect(rollbackTo(db, migDir, "20260101000000-a", {})).rejects.toThrow(
      /no such table: nonexistent_xyz/i,
    );

    // c rolled back fully (its tx committed before b's failed).
    expect(await tableExists(db, "c")).toBe(false);
    // b's tx rolled back atomically: the table survives and the ledger keeps it.
    expect(await tableExists(db, "b")).toBe(true);
    // a was never reached.
    expect(await tableExists(db, "a")).toBe(true);
    expect([...(await appliedNames(db))].sort()).toEqual(["20260101000000-a", "20260102000000-b"]);
  });
});
