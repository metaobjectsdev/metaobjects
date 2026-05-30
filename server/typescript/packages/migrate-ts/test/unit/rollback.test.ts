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
});
