import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import {
  ensureLedger,
  recordApplied,
  deleteApplied,
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

  test("default opts preserve original behavior (no opts === public/_metaobjects_migrations)", async () => {
    // ensureLedger() with no dialect/opts must create exactly _metaobjects_migrations.
    await ensureLedger(db);
    const rows = await sql<{ c: number }>`
      SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name=${MIGRATIONS_TABLE}
    `.execute(db);
    expect((rows.rows[0]?.c ?? 0) > 0).toBe(true);
    await recordApplied(db, "20260101000000-a", "csum-a");
    // Reading with explicit default opts must see the same row.
    expect((await appliedNames(db, "sqlite", { table: MIGRATIONS_TABLE })).has("20260101000000-a")).toBe(true);
  });

  test("multi-tenant: two ledgers with different table names track independently (one DB)", async () => {
    const tenantA = { table: "tenant_a_migrations" };
    const tenantB = { table: "tenant_b_migrations" };
    await ensureLedger(db, "sqlite", tenantA);
    await ensureLedger(db, "sqlite", tenantB);

    await recordApplied(db, "20260101000000-a", "csum-a", "sqlite", tenantA);

    expect((await appliedNames(db, "sqlite", tenantA)).has("20260101000000-a")).toBe(true);
    // tenant B's ledger is a separate table — unaffected.
    expect((await appliedNames(db, "sqlite", tenantB)).size).toBe(0);
    // The default ledger likewise has nothing.
    await ensureLedger(db);
    expect((await appliedNames(db)).size).toBe(0);
  });

  test("deleteApplied removes a ledger row (rollback unrecord)", async () => {
    await ensureLedger(db);
    await recordApplied(db, "20260101000000-a", "csum-a");
    await recordApplied(db, "20260102000000-b", "csum-b");
    await deleteApplied(db, "20260102000000-b");
    const names = await appliedNames(db);
    expect(names.has("20260101000000-a")).toBe(true);
    expect(names.has("20260102000000-b")).toBe(false);
  });
});
