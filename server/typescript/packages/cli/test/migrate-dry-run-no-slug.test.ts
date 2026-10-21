/**
 * A `--dry-run` preview names no migration: `--slug` is required to WRITE one, not to
 * look at the SQL. The check used to sit before the dry-run branch, so a preview of a
 * pending change failed with "--slug <name> required".
 */
import { describe, test, expect, afterAll, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateCommand } from "../src/commands/migrate.js";
import { log } from "../src/lib/log.js";
import { snapshotPath, writeSnapshot } from "@metaobjectsdev/migrate-ts";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const MODEL = JSON.stringify({
  "metadata.root": {
    package: "acme::platform",
    children: [{
      "object.entity": {
        name: "Job",
        children: [
          { "source.rdb": { name: "src", "@table": "jobs" } },
          { "field.long": { name: "id" } },
          { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        ],
      },
    }],
  },
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dry-run-slug-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.platform.json"), MODEL, "utf8");
  await mkdir(join(root, ".metaobjects", "migrations"), { recursive: true });
  await writeFile(join(root, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, migrate: { dialect: "sqlite" } }), "utf8");
  return root;
}

const files = async (root: string) =>
  (await readdir(join(root, ".metaobjects", "migrations"))).filter((e) => !e.startsWith("."));

let out: string[] = [];
let infoSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  out = [];
  infoSpy = spyOn(log, "info").mockImplementation((m: string) => { out.push(String(m)); });
  errSpy = spyOn(log, "error").mockImplementation((m: string) => { out.push(String(m)); });
});
afterEach(() => { infoSpy.mockRestore(); errSpy.mockRestore(); });

describe("meta migrate --dry-run needs no --slug", () => {
  test("live (--from-db): previews the SQL, exits 0, writes nothing", async () => {
    const root = await project();
    expect(await migrateCommand(["--from-db", "--db", `file:${join(root, "t.db")}`, "--dialect", "sqlite", "--dry-run"], root)).toBe(0);
    expect(out.join("\n")).toContain("CREATE TABLE");
    expect(out.join("\n")).not.toContain("--slug");
    expect(await files(root)).toEqual([]);
  });

  test("offline (against the committed snapshot): previews, exits 0, writes nothing", async () => {
    const root = await project();
    await writeSnapshot(snapshotPath(join(root, ".metaobjects", "migrations"), "sqlite"), { tables: [], views: [] });
    expect(await migrateCommand(["--dialect", "sqlite", "--dry-run"], root)).toBe(0);
    expect(out.join("\n")).toContain("CREATE TABLE");
    expect(await files(root)).toEqual([]);
    expect(await migrateCommand(["--dialect", "sqlite"], root)).toBe(2);
  });

  test("the same change WITHOUT --dry-run still requires --slug", async () => {
    const root = await project();
    expect(await migrateCommand(["--from-db", "--db", `file:${join(root, "t.db")}`, "--dialect", "sqlite"], root)).toBe(2);
    expect(out.join("\n")).toContain("--slug <name> required");
    expect(await files(root)).toEqual([]);
  });
});
