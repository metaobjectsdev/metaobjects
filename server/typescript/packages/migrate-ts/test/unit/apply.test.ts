import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { applyPending } from "../../src/apply/apply.js";
import { ensureLedger, recordApplied, appliedNames } from "../../src/apply/ledger.js";

function writeMig(root: string, name: string, up: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "up.sql"), up, "utf8");
  writeFileSync(join(dir, "down.sql"), "", "utf8");
}

async function tableExists(db: Kysely<Record<string, unknown>>, name: string): Promise<boolean> {
  const rows = await sql<{ c: number }>`
    SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name=${name}
  `.execute(db);
  return (rows.rows[0]?.c ?? 0) > 0;
}

describe("applyPending — ordered, transactional, ledger-tracked", () => {
  let db: Kysely<Record<string, unknown>>;
  let tmp: string;
  let migDir: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "apply-test-"));
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

  test("runs only pending files, in order, and records them", async () => {
    writeMig(migDir, "20260101000000-a", "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    writeMig(migDir, "20260102000000-b", "CREATE TABLE b (id INTEGER PRIMARY KEY);");
    // Mark the first as already applied (with its real checksum so no tamper error).
    await ensureLedger(db);

    const result = await applyPending(db, migDir, { dryRun: false });

    // Both should now be applied; only b was newly run.
    expect(result.applied).toEqual(["20260101000000-a", "20260102000000-b"]);
    expect(await tableExists(db, "a")).toBe(true);
    expect(await tableExists(db, "b")).toBe(true);
    expect((await appliedNames(db)).size).toBe(2);
  });

  test("skips already-applied files (idempotent on re-run)", async () => {
    writeMig(migDir, "20260101000000-a", "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    await applyPending(db, migDir, { dryRun: false });
    // Second run: nothing pending.
    const second = await applyPending(db, migDir, { dryRun: false });
    expect(second.applied).toEqual([]);
    expect((await appliedNames(db)).size).toBe(1);
  });

  test("a failing statement rolls back that file's tx and leaves it UNrecorded", async () => {
    writeMig(migDir, "20260101000000-a", "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    // Second file: first stmt valid, second is broken → whole file must roll back.
    writeMig(
      migDir,
      "20260102000000-bad",
      "CREATE TABLE b (id INTEGER PRIMARY KEY);\nCREATE TABLE b (id INTEGER PRIMARY KEY);",
    );

    await expect(applyPending(db, migDir, { dryRun: false })).rejects.toThrow();

    // a applied + recorded; bad rolled back (table b absent) + not recorded.
    expect(await tableExists(db, "a")).toBe(true);
    expect(await tableExists(db, "b")).toBe(false);
    const names = await appliedNames(db);
    expect(names.has("20260101000000-a")).toBe(true);
    expect(names.has("20260102000000-bad")).toBe(false);
  });

  test("retries a previously-failed file on re-run", async () => {
    writeMig(migDir, "20260101000000-a", "CREATE TABLE a (id INTEGER PRIMARY KEY); INVALID SQL;");
    await expect(applyPending(db, migDir, { dryRun: false })).rejects.toThrow();
    expect((await appliedNames(db)).has("20260101000000-a")).toBe(false);

    // Fix the file and re-run; it should now apply.
    writeFileSync(join(migDir, "20260101000000-a", "up.sql"), "CREATE TABLE a (id INTEGER PRIMARY KEY);", "utf8");
    const result = await applyPending(db, migDir, { dryRun: false });
    expect(result.applied).toEqual(["20260101000000-a"]);
    expect(await tableExists(db, "a")).toBe(true);
  });

  test("hand-edited file SQL is applied verbatim (incl. data steps)", async () => {
    writeMig(
      migDir,
      "20260101000000-seed",
      "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);\nINSERT INTO t (id, name) VALUES (1, 'hand-edited');",
    );
    await applyPending(db, migDir, { dryRun: false });
    const rows = await sql<{ name: string }>`SELECT name FROM t WHERE id=1`.execute(db);
    expect(rows.rows[0]?.name).toBe("hand-edited");
  });

  test("checksum drift on a previously-applied file → error (tamper guard)", async () => {
    writeMig(migDir, "20260101000000-a", "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    await applyPending(db, migDir, { dryRun: false });
    // Tamper the already-applied file's content.
    writeFileSync(join(migDir, "20260101000000-a", "up.sql"), "CREATE TABLE a (id INTEGER PRIMARY KEY, extra TEXT);", "utf8");
    await expect(applyPending(db, migDir, { dryRun: false })).rejects.toThrow(/checksum|tamper|changed/i);
  });

  test("dryRun returns the plan and applies nothing", async () => {
    writeMig(migDir, "20260101000000-a", "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    const result = await applyPending(db, migDir, { dryRun: true });
    expect(result.pending).toEqual(["20260101000000-a"]);
    expect(result.applied).toEqual([]);
    expect(await tableExists(db, "a")).toBe(false);
    expect((await appliedNames(db)).size).toBe(0);
  });
});
