/**
 * `meta migrate baseline --from-db` on Postgres records the GENERATED spelling of a CHECK the
 * live database proves equal to the metadata's, instead of Postgres's own spelling of it.
 *
 * The offline plan has no database to ask, so it compares the snapshot's text with the text
 * migrate generates through a string normaliser. Postgres rewrites a one-element
 * `IN ('SPACE')` to `= 'SPACE'::text`; with the generated text in the snapshot the two sides
 * are the same string and the offline plan starts clean. A baseline whose metadata will not
 * load must still work, and keeps Postgres's text.
 *
 * Skips gracefully when MIGRATE_TS_PG_URL is not set.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { snapshotPath, readSnapshot } from "@metaobjectsdev/migrate-ts";
import { run } from "../../src/index.js";

const PG_URL = process.env.MIGRATE_TS_PG_URL;
const TABLE = "canon_baseline_t";

const MODEL = JSON.stringify({
  "metadata.root": {
    children: [{
      "object.entity": {
        name: "CanonBaseline",
        children: [
          { "source.rdb": { name: "src", "@table": TABLE } },
          { "field.long": { name: "id" } },
          { "field.enum": { name: "kind", "@values": ["SPACE"] } },
          { "field.int": { name: "qty", children: [{ "validator.numeric": { name: "range", "@min": 1, "@max": 100 } }] } },
          { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        ],
      },
    }],
  },
});

describe("meta migrate baseline --from-db — postgres spelling (env-gated)", () => {
  if (PG_URL === undefined || PG_URL.length === 0) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    return;
  }
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
  });
  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await pool.end();
  });

  const checksOf = async (root: string): Promise<Record<string, string>> => {
    const snapshot = await readSnapshot(snapshotPath(join(root, ".metaobjects", "migrations"), "postgres"));
    const table = snapshot!.tables.find((t) => t.name === TABLE)!;
    return Object.fromEntries(table.checks.map((c) => [c.name, c.expression]));
  };
  const migrationDirs = (root: string): string[] =>
    readdirSync(join(root, ".metaobjects", "migrations")).filter((e) => !e.startsWith("."));

  test("the generated text lands in the snapshot, and the offline plan is then clean", async () => {
    const root = mkdtempSync(join(tmpdir(), "baseline-pg-canon-"));
    try {
      mkdirSync(join(root, "metaobjects"), { recursive: true });
      writeFileSync(join(root, "metaobjects", "meta.canon.json"), MODEL, "utf8");

      // Day 1: create the table. The snapshot this writes holds the GENERATED spelling.
      expect(await run(["migrate", "--cwd", root, "--from-db", "--db", PG_URL, "--dialect", "postgres", "--slug", "init", "--apply"])).toBe(0);
      const generated = await checksOf(root);
      expect(Object.keys(generated).length).toBeGreaterThan(0);
      const live = (await pool.query(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = '${TABLE}'::regclass AND contype = 'c'`,
      )).rows as Array<{ conname: string; def: string }>;
      // The gate is not vacuous: Postgres really does spell the one-value enum differently.
      expect(live.find((r) => r.conname.includes("kind"))!.def).toContain("'SPACE'::text");
      expect(generated[live.find((r) => r.conname.includes("kind"))!.conname]).not.toContain("::text");

      // Re-baseline from the live database: the snapshot must hold the generated text again.
      rmSync(snapshotPath(join(root, ".metaobjects", "migrations"), "postgres"));
      expect(await run(["migrate", "baseline", "--cwd", root, "--from-db", "--db", PG_URL, "--dialect", "postgres"])).toBe(0);
      expect(await checksOf(root)).toEqual(generated);

      // The offline plan (no database) is clean: it writes no migration.
      const before = migrationDirs(root);
      expect(await run(["migrate", "--cwd", root, "--dialect", "postgres", "--slug", "noop"])).toBe(0);
      expect(migrationDirs(root)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("metadata that will not load does not fail the baseline, which keeps Postgres's text", async () => {
    const root = mkdtempSync(join(tmpdir(), "baseline-pg-canon-bad-"));
    try {
      mkdirSync(join(root, "metaobjects"), { recursive: true });
      writeFileSync(join(root, "metaobjects", "meta.canon.json"), "{ not json", "utf8");
      expect(await run(["migrate", "baseline", "--cwd", root, "--from-db", "--db", PG_URL, "--dialect", "postgres"])).toBe(0);
      expect(existsSync(snapshotPath(join(root, ".metaobjects", "migrations"), "postgres"))).toBe(true);
      const checks = await checksOf(root);
      expect(Object.values(checks).some((e) => e.includes("::text"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
