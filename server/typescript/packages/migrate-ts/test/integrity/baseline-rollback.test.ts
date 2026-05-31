// test/integrity/baseline-rollback.test.ts
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { applyPending, rollbackTo } from "../../src/apply/apply.js";
import { recordBaseline, baselineRecord } from "../../src/apply/ledger.js";

const tmps: string[] = [];
function db(file: string) {
  return new Kysely<Record<string, unknown>>({
    dialect: new LibsqlDialect({ url: `file:${file}` }),
  });
}
async function root() {
  const d = await mkdtemp(join(tmpdir(), "baseline-rollback-"));
  tmps.push(d);
  return d;
}
async function writeMigration(
  dir: string,
  name: string,
  up: string,
  down: string,
): Promise<void> {
  const mdir = join(dir, name);
  await mkdir(mdir, { recursive: true });
  await writeFile(join(mdir, "up.sql"), up, "utf8");
  await writeFile(join(mdir, "down.sql"), down, "utf8");
}
async function tableExists(
  k: Kysely<Record<string, unknown>>,
  name: string,
): Promise<boolean> {
  const r = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}
  `.execute(k);
  return r.rows.length > 0;
}

afterAll(async () => {
  for (const d of tmps) await rm(d, { recursive: true, force: true });
});

describe("rollback-all with a baseline marker present", () => {
  test("rollback-all ignores the baseline marker and runs the real down", async () => {
    const r = await root();
    const migrationsDir = join(r, "migrations");
    await writeMigration(
      migrationsDir,
      "20260101000000-init",
      `CREATE TABLE t ( id INTEGER NOT NULL PRIMARY KEY );`,
      `DROP TABLE t;`,
    );
    const k = db(join(r, "rb.db"));
    try {
      // Apply the one real migration.
      await applyPending(k, migrationsDir, { dryRun: false, dialect: "sqlite" });
      expect(await tableExists(k, "t")).toBe(true);

      // Record a baseline marker row in the ledger (NOT a migration).
      await recordBaseline(k, "sqlite", "somehash");

      // Rollback ALL — must NOT throw on the 0000-baseline sentinel.
      const result = await rollbackTo(k, migrationsDir, null, {
        dialect: "sqlite",
      });

      // The real migration's down ran (table gone), baseline was not treated
      // as a migration.
      expect(result.rolledBack).toEqual(["20260101000000-init"]);
      expect(await tableExists(k, "t")).toBe(false);

      // Baseline is still readable (the filter only hides it from listings).
      expect((await baselineRecord(k, "sqlite"))?.checksum).toBe("somehash");
    } finally {
      await k.destroy();
    }
  });
});
