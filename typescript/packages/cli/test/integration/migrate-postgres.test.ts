import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../../src/index.js";

const FIXTURES = resolve("packages/cli/test/fixtures");
const PG_URL = process.env.MIGRATE_TS_PG_URL;

describe("meta migrate — postgres (env-gated)", () => {
  if (PG_URL === undefined || PG_URL.length === 0) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    return;
  }

  test("meta migrate against real Postgres writes CREATE TABLE migration", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-migrate-pg-"));
    cpSync(join(FIXTURES, "downstream-consumer-meta"), root, { recursive: true });
    const orig = process.cwd();
    process.chdir(root);
    try {
      const exit = await run(["migrate", "--db", PG_URL, "--slug", "initial"]);
      expect(exit).toBe(0);

      const migrationsRoot = join(root, ".metaobjects", "migrations");
      const subdirs = readdirSync(migrationsRoot);
      const dir = subdirs.find((s) => s.endsWith("-initial"));
      expect(dir).toBeDefined();
      const sql = readFileSync(join(migrationsRoot, dir!, "up.sql"), "utf8");
      expect(sql).toMatch(/CREATE TABLE.*users/i);
    } finally {
      process.chdir(orig);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
