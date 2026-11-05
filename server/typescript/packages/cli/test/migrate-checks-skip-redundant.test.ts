/**
 * `migrate.checks.skipRedundant` in .metaobjects/config.json reaches `meta migrate` and
 * `meta verify --db`: a `validator.length` minimum of 0 is left out of the CHECK (on SQLite
 * the maximum stays, since SQLite does not enforce VARCHAR(n)). It is not a schema
 * convention: `migrate.conventions: "efcore"` alone emits the CHECK whole. A malformed
 * `checks` block is refused as a config error.
 */
import { describe, test, expect, afterAll, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateCommand } from "../src/commands/migrate.js";
import { verifyCommand } from "../src/commands/verify.js";
import { log } from "../src/lib/log.js";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const MODEL = JSON.stringify({
  "metadata.root": {
    package: "acme::platform",
    children: [
      { "object.entity": { name: "Ticket", children: [
        { "source.rdb": { name: "src", "@table": "tickets" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "code", "@maxLength": 3, children: [
          { "validator.length": { name: "len", "@min": 0, "@max": 3 } },
        ] } },
        { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
      ] } },
    ],
  },
});

async function writeConfig(root: string, migrate: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, ".metaobjects", "config.json"),
    JSON.stringify({ schema_version: 1, migrate: { dialect: "sqlite", ...migrate } }), "utf8");
}

async function project(migrate: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "checks-skip-redundant-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.platform.json"), MODEL, "utf8");
  await mkdir(join(root, ".metaobjects", "migrations"), { recursive: true });
  await writeConfig(root, migrate);
  return root;
}

let out: string[] = [];
let spies: ReturnType<typeof spyOn>[] = [];
beforeEach(() => {
  out = [];
  const push = (m: unknown) => { out.push(String(m)); };
  spies = [
    spyOn(log, "info").mockImplementation(push),
    spyOn(log, "error").mockImplementation(push),
    spyOn(log, "warn").mockImplementation(push),
    spyOn(console, "log").mockImplementation(push),
    spyOn(console, "error").mockImplementation(push),
  ];
});
afterEach(() => { for (const s of spies) s.mockRestore(); });

const db = (root: string) => `file:${join(root, "t.db")}`;
const dryRun = (root: string) =>
  migrateCommand(["--from-db", "--db", db(root), "--dialect", "sqlite", "--dry-run"], root);

const WHOLE = 'CHECK (length("code") >= 0 AND length("code") <= 3)';
const SKIPPED = 'CHECK (length("code") <= 3)';

describe("migrate.checks.skipRedundant", () => {
  test("meta migrate leaves the redundant part of the CHECK out", async () => {
    const root = await project({ checks: { skipRedundant: true } });

    expect(await dryRun(root)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(SKIPPED);
    expect(text).not.toContain(WHOLE);
  });

  test("absent, and under the efcore conventions alone, the CHECK is emitted whole", async () => {
    for (const migrate of [{}, { conventions: "efcore" }, { checks: { skipRedundant: false } }]) {
      out = [];
      const root = await project(migrate);
      expect(await dryRun(root)).toBe(0);
      expect(out.join("\n")).toContain(WHOLE);
    }
  });

  test("meta verify --db compares against the same setting", async () => {
    const root = await project({ checks: { skipRedundant: true } });
    expect(await migrateCommand(["--from-db", "--db", db(root), "--dialect", "sqlite", "--slug", "init", "--apply"], root)).toBe(0);

    out = [];
    expect(await verifyCommand(["--db", db(root), "--dialect", "sqlite"], root)).toBe(0);

    // The database was built without the redundant part; a project that wants it reports drift.
    await writeConfig(root, {});
    out = [];
    expect(await verifyCommand(["--db", db(root), "--dialect", "sqlite"], root)).toBe(1);
    expect(out.join("\n")).toContain("tickets_code_length_chk");
  });

  test("a malformed checks block is refused, naming the key", async () => {
    for (const [checks, says] of [
      [true, "migrate.checks"],
      [{ skipRedundnat: true }, "skipRedundnat"],
      [{ skipRedundant: "yes" }, "migrate.checks.skipRedundant"],
    ] as const) {
      out = [];
      const root = await project({ checks });
      const migrateCode = await dryRun(root);
      expect(migrateCode).not.toBe(0);
      expect(out.join("\n")).toContain(says);
      out = [];
      expect(await verifyCommand([], root)).not.toBe(0);
      expect(out.join("\n")).toContain(says);
    }
  });
});
