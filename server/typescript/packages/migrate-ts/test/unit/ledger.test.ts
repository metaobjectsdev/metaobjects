import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import {
  ensureLedger,
  recordApplied,
  appliedNames,
  appliedRecords,
  MIGRATIONS_TABLE,
} from "../../src/apply/ledger.js";

describe("migration-history ledger", () => {
  let db: Kysely<Record<string, unknown>>;
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ledger-test-"));
    db = new Kysely<Record<string, unknown>>({
      dialect: new LibsqlDialect({ url: `file:${join(tmp, "test.db")}` }),
    });
  });
  afterEach(async () => {
    await db.destroy();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("ensureLedger creates _metaobjects_migrations", async () => {
    expect(MIGRATIONS_TABLE).toBe("_metaobjects_migrations");
    await ensureLedger(db);
    // Empty table → no applied names.
    expect((await appliedNames(db)).size).toBe(0);
  });

  test("ensureLedger is idempotent (no-op when table exists)", async () => {
    await ensureLedger(db);
    await recordApplied(db, "20260101000000-initial", "abc");
    // Re-running must not throw nor wipe existing rows.
    await ensureLedger(db);
    expect((await appliedNames(db)).has("20260101000000-initial")).toBe(true);
  });

  test("recordApplied inserts; appliedNames returns the set", async () => {
    await ensureLedger(db);
    await recordApplied(db, "20260101000000-a", "csum-a");
    await recordApplied(db, "20260102000000-b", "csum-b");
    const names = await appliedNames(db);
    expect(names.has("20260101000000-a")).toBe(true);
    expect(names.has("20260102000000-b")).toBe(true);
    expect(names.size).toBe(2);
  });

  test("appliedRecords returns name→checksum map", async () => {
    await ensureLedger(db);
    await recordApplied(db, "20260101000000-a", "csum-a");
    const records = await appliedRecords(db);
    expect(records.get("20260101000000-a")).toBe("csum-a");
  });
});
