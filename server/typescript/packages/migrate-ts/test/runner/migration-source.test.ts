// test/runner/migration-source.test.ts
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMigrations } from "../../src/runner/migration-source.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mig-"));
  await mkdir(join(dir, "20260101120000-create-a"));
  await writeFile(join(dir, "20260101120000-create-a", "up.sql"), "CREATE TABLE a();");
  await writeFile(join(dir, "20260101120000-create-a", "down.sql"), "DROP TABLE a;");
  await mkdir(join(dir, "20260102120000-create-b"));
  await writeFile(join(dir, "20260102120000-create-b", "up.sql"), "CREATE TABLE b();");
  // no down.sql for b
  await writeFile(join(dir, "README.md"), "not a migration");
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe("loadMigrations", () => {
  test("loads timestamped dirs sorted by version; non-migration entries ignored", async () => {
    const migs = await loadMigrations(dir);
    expect(migs.map((m) => m.version)).toEqual(["20260101120000", "20260102120000"]);
    expect(migs[0].name).toBe("create-a");
    expect(migs[0].upSql).toBe("CREATE TABLE a();");
    expect(migs[0].downSql).toBe("DROP TABLE a;");
    expect(migs[1].downSql).toBe(""); // missing down.sql → empty
  });
  test("returns [] for a missing directory", async () => {
    expect(await loadMigrations(join(dir, "nope"))).toEqual([]);
  });
});
