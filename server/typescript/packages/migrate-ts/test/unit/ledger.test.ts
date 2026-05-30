import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import {
  DummyDriver,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from "kysely";
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

  test("rejects a dotted/unsafe table name with a clear, option-naming error", async () => {
    await expect(
      ensureLedger(db, "sqlite", { table: "v1.2_migrations" }),
    ).rejects.toThrow(/LedgerOptions\.table.*v1\.2_migrations/);
  });

  test("rejects a dotted/unsafe schema name (pg) with a clear, option-naming error", async () => {
    await expect(
      ensureLedger(db, "postgres", { schema: "tenant.eu" }),
    ).rejects.toThrow(/LedgerOptions\.schema.*tenant\.eu/);
  });
});

describe("ledger identifier qualification (pg, compiled SQL — no live DB)", () => {
  /**
   * Capture compiled SQL without a live Postgres: a Postgres dialect driven by a
   * DummyDriver (no I/O) whose connection records every compiled query before
   * returning an empty rowset. This proves a simple `table`/`schema` is emitted
   * as SEPARATE quoted identifiers (the one `.` between them is the part
   * separator, NOT a separator inside either part).
   */
  function makeCapturingDb(): { db: Kysely<Record<string, unknown>>; sqls: string[] } {
    const sqls: string[] = [];
    class CapturingConnection implements DatabaseConnection {
      async executeQuery<R>(cq: CompiledQuery): Promise<QueryResult<R>> {
        sqls.push(cq.sql);
        return { rows: [] };
      }
      async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
        // Unused by the ledger fns; satisfies the interface.
      }
    }
    class CapturingDriver extends DummyDriver {
      override async acquireConnection(): Promise<DatabaseConnection> {
        return new CapturingConnection();
      }
    }
    const db = new Kysely<Record<string, unknown>>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new CapturingDriver(),
        createIntrospector: (d) => new PostgresIntrospector(d),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    return { db, sqls };
  }

  test('a simple table+schema qualifies as "schema"."table" (two single identifiers)', async () => {
    const { db, sqls } = makeCapturingDb();
    await recordApplied(db, "20260101000000-a", "csum-a", "postgres", {
      schema: "tenant_eu",
      table: "mo_migrations",
    });
    const insert = sqls.find((s) => s.toLowerCase().includes("insert into"));
    expect(insert).toBeDefined();
    // Each part quoted separately — NOT a single "tenant_eu.mo_migrations" blob.
    expect(insert).toContain('"tenant_eu"."mo_migrations"');
    await db.destroy();
  });
});
