import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../../src/index.js";

const FIXTURES = resolve("packages/cli/test/fixtures");

describe("meta migrate --dry-run", () => {
  test("returns 0, prints SQL to stdout, writes no migration directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-migrate-dryrun-"));
    cpSync(join(FIXTURES, "downstream-consumer-meta"), root, { recursive: true });
    const dbUrl = `file:${join(root, "local.db")}`;
    const orig = process.cwd();
    process.chdir(root);

    const captured: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => { captured.push(msg); };

    try {
      const exit = await run(["migrate", "--db", dbUrl, "--slug", "initial", "--dry-run"]);
      expect(exit).toBe(0);

      const stdout = captured.join("\n");
      expect(stdout).toMatch(/CREATE TABLE/i);
      expect(stdout).toContain("-- UP --");
      expect(stdout).toContain("-- DOWN --");

      expect(existsSync(join(root, ".metaobjects", "migrations"))).toBe(false);
    } finally {
      console.log = origLog;
      process.chdir(orig);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
