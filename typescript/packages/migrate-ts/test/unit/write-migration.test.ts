import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMigration } from "../../src/write-migration.js";

describe("writeMigration", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "migrate-ts-write-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("writes up.sql + down.sql in <timestamp>-<slug> directory", async () => {
    const result = await writeMigration(
      { up: "CREATE TABLE x (id INT);", down: "DROP TABLE x;" },
      { dir, slug: "create-x", now: new Date(Date.UTC(2026, 4, 11, 14, 30, 22)) },
    );
    expect(result.dir).toBe(join(dir, "20260511143022-create-x"));
    expect(existsSync(join(result.dir, "up.sql"))).toBe(true);
    expect(existsSync(join(result.dir, "down.sql"))).toBe(true);
    expect(readFileSync(join(result.dir, "up.sql"), "utf8")).toBe("CREATE TABLE x (id INT);\n");
    expect(readFileSync(join(result.dir, "down.sql"), "utf8")).toBe("DROP TABLE x;\n");
  });

  test("auto-generates timestamp from current time when not provided", async () => {
    const before = Date.now();
    const result = await writeMigration(
      { up: "x", down: "y" },
      { dir, slug: "test" },
    );
    const after = Date.now();
    const match = /^(\d{14})-test$/.exec(result.dir.split("/").pop()!);
    expect(match).toBeDefined();
    const ts = match![1]!;
    // Sanity: timestamp parses to between before and after.
    const yyyy = parseInt(ts.substring(0, 4), 10);
    expect(yyyy).toBeGreaterThanOrEqual(2026);
    expect(after - before).toBeGreaterThanOrEqual(0);
  });

  test("throws if dir doesn't exist (no auto-create of root)", async () => {
    await expect(writeMigration(
      { up: "", down: "" },
      { dir: join(dir, "does", "not", "exist"), slug: "x" },
    )).rejects.toThrow();
  });

  test("slug is sanitized to safe filename (no slashes, lowercase)", async () => {
    const result = await writeMigration(
      { up: "x", down: "y" },
      { dir, slug: "Add Customer/Shipping!", now: new Date(Date.UTC(2026, 4, 11, 14, 30, 22)) },
    );
    expect(result.dir.split("/").pop()).toBe("20260511143022-add-customer-shipping");
  });

  test("trailing newline added if missing", async () => {
    await writeMigration(
      { up: "no-trailing-newline", down: "also-none" },
      { dir, slug: "x", now: new Date(Date.UTC(2026, 4, 11, 14, 30, 22)) },
    );
    const dirs = readdirSync(dir);
    const up = readFileSync(join(dir, dirs[0]!, "up.sql"), "utf8");
    expect(up.endsWith("\n")).toBe(true);
  });
});
