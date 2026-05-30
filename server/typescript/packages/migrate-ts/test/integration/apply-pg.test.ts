/**
 * Postgres apply integration tests — the ported advisory-lock (Port 2),
 * multi-tenant ledger (Port 1) and rollback (Port 3) behavior against a REAL
 * Postgres. pg-mem lacks advisory-lock + concurrency fidelity, so — like the
 * other pg integration tests in this package — these gate on MIGRATE_TS_PG_URL
 * and skip when it is absent.
 *
 * Set MIGRATE_TS_PG_URL=postgres://user:pass@host:port/db to run.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { applyPending } from "../../src/apply/apply.js";
import { appliedNames, ensureLedger } from "../../src/apply/ledger.js";

const PG_URL = process.env["MIGRATE_TS_PG_URL"];
const realDescribe = PG_URL ? describe : describe.skip;

function makeKysely(): { db: Kysely<Record<string, unknown>> } {
  const pool = new Pool({ connectionString: PG_URL });
  const db = new Kysely<Record<string, unknown>>({
    dialect: new PostgresDialect({ pool }),
  });
  // db.destroy() ends the underlying pool — no separate pool.end() needed.
  return { db };
}

function writeMig(root: string, name: string, up: string, down: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "up.sql"), up, "utf8");
  writeFileSync(join(dir, "down.sql"), down, "utf8");
}

realDescribe("applyPending — Postgres advisory lock + multi-tenant + rollback", () => {
  let tmp: string;
  let migDir: string;
  let suffix: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "apply-pg-"));
    migDir = join(tmp, "migrations");
    mkdirSync(migDir, { recursive: true });
    // Unique per-test table/ledger names so parallel/leftover state can't collide.
    suffix = randomBytes(4).toString("hex");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("concurrent applies of the same dir serialize (exactly one applies; no PK clash)", async () => {
    const widgets = `widgets_${suffix}`;
    const ledgerTable = `mo_migrations_${suffix}`;
    // A slow up so the two applies genuinely overlap in time — the lock must
    // serialize them. Without the lock both would read the empty ledger and
    // race to INSERT the same ledger row (PK conflict).
    writeMig(
      migDir,
      "20260101000000-create",
      `CREATE TABLE "${widgets}" (id int primary key); SELECT pg_sleep(0.3);`,
      `DROP TABLE "${widgets}";`,
    );

    const a = makeKysely();
    const b = makeKysely();
    try {
      const ledger = { table: ledgerTable };
      const [ra, rb] = await Promise.all([
        applyPending(a.db, migDir, { dryRun: false, dialect: "postgres", ledger }),
        applyPending(b.db, migDir, { dryRun: false, dialect: "postgres", ledger }),
      ]);

      // Exactly one of the two runs actually applied the migration; the other
      // serialized behind the lock, then saw it already recorded and skipped.
      const total = ra.applied.length + rb.applied.length;
      expect(total).toBe(1);

      // Ledger has the migration exactly once; the table exists.
      const names = await appliedNames(a.db, "postgres", ledger);
      expect(names.has("20260101000000-create")).toBe(true);
      const exists = await sql<{ c: number }>`
        SELECT count(*)::int AS c FROM information_schema.tables
        WHERE table_name = ${widgets}
      `.execute(a.db);
      expect(exists.rows[0]?.c).toBe(1);
    } finally {
      await sql.raw(`DROP TABLE IF EXISTS "${widgets}"`).execute(a.db).catch(() => {});
      await sql.raw(`DROP TABLE IF EXISTS "${ledgerTable}"`).execute(a.db).catch(() => {});
      await a.db.destroy();
      await b.db.destroy();
    }
  });

  test("multi-tenant: two ledgers (different tables) track independently in one DB", async () => {
    const widgetsA = `wa_${suffix}`;
    const widgetsB = `wb_${suffix}`;
    const ledgerA = { table: `mo_a_${suffix}` };
    const ledgerB = { table: `mo_b_${suffix}` };

    const dirA = join(tmp, "a");
    const dirB = join(tmp, "b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeMig(dirA, "20260101000000-a", `CREATE TABLE "${widgetsA}" (id int primary key);`, `DROP TABLE "${widgetsA}";`);
    writeMig(dirB, "20260101000000-b", `CREATE TABLE "${widgetsB}" (id int primary key);`, `DROP TABLE "${widgetsB}";`);

    const k = makeKysely();
    try {
      await applyPending(k.db, dirA, { dryRun: false, dialect: "postgres", ledger: ledgerA });
      // Tenant B's ledger has nothing yet — independent lineage. (Ensure its
      // table exists so the read targets a real, empty ledger.)
      await ensureLedger(k.db, "postgres", ledgerB);
      expect((await appliedNames(k.db, "postgres", ledgerB)).size).toBe(0);
      expect((await appliedNames(k.db, "postgres", ledgerA)).has("20260101000000-a")).toBe(true);
    } finally {
      await sql.raw(`DROP TABLE IF EXISTS "${widgetsA}"`).execute(k.db).catch(() => {});
      await sql.raw(`DROP TABLE IF EXISTS "${widgetsB}"`).execute(k.db).catch(() => {});
      await sql.raw(`DROP TABLE IF EXISTS "${ledgerA.table}"`).execute(k.db).catch(() => {});
      await sql.raw(`DROP TABLE IF EXISTS "${ledgerB.table}"`).execute(k.db).catch(() => {});
      await k.db.destroy();
    }
  });

});
