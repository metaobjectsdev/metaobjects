import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMigrationD1 } from "../../src/write-migration-d1.js";

describe("writeMigrationD1", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "migrate-d1-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("writes 0001_<slug>.sql in an empty migrations dir", async () => {
    const result = await writeMigrationD1(
      { up: "CREATE TABLE x (id INT);", down: "DROP TABLE x;" },
      { dir, slug: "init" },
    );
    expect(result.upPath).toBe(join(dir, "0001_init.sql"));
    expect(result.downPath).toBe(join(dir, ".down", "0001_init.sql"));
    expect(result.sequence).toBe(1);
    expect(readFileSync(result.upPath, "utf8")).toBe("CREATE TABLE x (id INT);\n");
    expect(readFileSync(result.downPath, "utf8")).toBe("DROP TABLE x;\n");
  });

  test("picks max(seq)+1 when prior migrations exist", async () => {
    writeFileSync(join(dir, "0001_init.sql"), "x");
    writeFileSync(join(dir, "0002_add-users.sql"), "x");
    writeFileSync(join(dir, "0007_skip.sql"), "x");
    const result = await writeMigrationD1(
      { up: "CREATE TABLE y (id INT);", down: "DROP TABLE y;" },
      { dir, slug: "next" },
    );
    expect(result.upPath).toBe(join(dir, "0008_next.sql"));
  });

  test("creates migrations dir if missing", async () => {
    const sub = join(dir, "db", "migrations");
    const result = await writeMigrationD1(
      { up: "x", down: "y" },
      { dir: sub, slug: "init" },
    );
    expect(existsSync(result.upPath)).toBe(true);
    expect(existsSync(result.downPath)).toBe(true);
  });

  test("creates .down subfolder", async () => {
    const result = await writeMigrationD1(
      { up: "x", down: "y" },
      { dir, slug: "init" },
    );
    expect(existsSync(join(dir, ".down"))).toBe(true);
    expect(result.downPath).toBe(join(dir, ".down", "0001_init.sql"));
  });

  test("ignores non-matching .sql files when assigning seq", async () => {
    writeFileSync(join(dir, "schema.sql"), "x");
    writeFileSync(join(dir, "0003_real.sql"), "x");
    const result = await writeMigrationD1(
      { up: "x", down: "y" },
      { dir, slug: "next" },
    );
    expect(result.upPath).toBe(join(dir, "0004_next.sql"));
  });

  test("does not recurse into .down when computing seq", async () => {
    mkdirSync(join(dir, ".down"), { recursive: true });
    writeFileSync(join(dir, ".down", "0099_old.sql"), "x");
    const result = await writeMigrationD1(
      { up: "x", down: "y" },
      { dir, slug: "init" },
    );
    expect(result.upPath).toBe(join(dir, "0001_init.sql"));
  });

  test("slug is sanitized to safe filename (lowercase, hyphens)", async () => {
    const result = await writeMigrationD1(
      { up: "x", down: "y" },
      { dir, slug: "Add Customer/Shipping!" },
    );
    expect(result.upPath).toBe(join(dir, "0001_add-customer-shipping.sql"));
  });

  test("trailing newline added if missing", async () => {
    const result = await writeMigrationD1(
      { up: "no-newline", down: "also-none" },
      { dir, slug: "x" },
    );
    expect(readFileSync(result.upPath, "utf8").endsWith("\n")).toBe(true);
    expect(readFileSync(result.downPath, "utf8").endsWith("\n")).toBe(true);
  });

  test("pads sequence to 4 digits up to 9999, then 5", async () => {
    writeFileSync(join(dir, "9999_max.sql"), "x");
    const result = await writeMigrationD1(
      { up: "x", down: "y" },
      { dir, slug: "next" },
    );
    expect(result.upPath).toBe(join(dir, "10000_next.sql"));
    expect(result.sequence).toBe(10000);
  });
});
