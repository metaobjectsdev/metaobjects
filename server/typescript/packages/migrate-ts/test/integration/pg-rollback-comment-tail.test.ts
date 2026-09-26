/**
 * A migration file whose tail is a comment-only block applies and rolls back on Postgres
 * too: the runner never sends a comment-only fragment to the driver, on any dialect.
 * (The SQLite half — where libsql failed the rollback with "SQLITE_OK: not an error" —
 * lives in test/unit/rollback.test.ts.) Skips when MIGRATE_TS_PG_URL is not set.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { applyPending, rollbackTo } from "../../src/apply/apply.js";

const PG_URL = process.env["MIGRATE_TS_PG_URL"];
const d = PG_URL ? describe : describe.skip;
const TABLE = "ct_comment_tail";
const LEDGER = { table: "ct_comment_tail_migrations" };

d("comment-only tail in up.sql / down.sql (PG)", () => {
  let pool: Pool;
  let db: Kysely<Record<string, unknown>>;
  let tmp: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    db = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool }) });
    await sql.raw(`DROP TABLE IF EXISTS ${TABLE}`).execute(db);
    await sql.raw(`DROP TABLE IF EXISTS ${LEDGER.table}`).execute(db);
    tmp = mkdtempSync(join(tmpdir(), "pg-comment-tail-"));
  });
  afterAll(async () => {
    await sql.raw(`DROP TABLE IF EXISTS ${TABLE}`).execute(db);
    await sql.raw(`DROP TABLE IF EXISTS ${LEDGER.table}`).execute(db);
    await db.destroy();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("applies and rolls back", async () => {
    const dir = join(tmp, "20260101000000-tail");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "up.sql"), `CREATE TABLE ${TABLE} (id INT);\n\n-- NOTE: trailing prose\n`);
    writeFileSync(join(dir, "down.sql"), `DROP TABLE ${TABLE};\n\n-- WARNING: a comment-only block\n/* and a block comment */\n`);

    const applied = await applyPending(db, tmp, { dryRun: false, dialect: "postgres", ledger: LEDGER });
    expect(applied.applied).toEqual(["20260101000000-tail"]);
    const rolled = await rollbackTo(db, tmp, null, { dialect: "postgres", ledger: LEDGER });
    expect(rolled.rolledBack).toEqual(["20260101000000-tail"]);
    const left = await sql<{ n: number }>`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = ${TABLE}`.execute(db);
    expect(left.rows[0]?.n).toBe(0);
  });
});
