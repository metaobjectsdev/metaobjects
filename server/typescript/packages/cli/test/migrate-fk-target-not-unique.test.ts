/**
 * An FK whose target columns are not a unique key is a metadata defect, not a tool
 * failure. On Postgres `meta migrate` refuses it with the engine's message and a hint, the
 * way it refuses two declarations that generate one database name, never as an "unexpected
 * error". On SQLite the DDL is accepted, so it is warned and the run goes on.
 */
import { describe, test, expect, afterAll, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { migrateCommand } from "../src/commands/migrate.js";
import { log } from "../src/lib/log.js";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const MODEL = JSON.stringify({
  "metadata.root": {
    package: "acme::platform",
    children: [
      {
        "object.entity": {
          name: "Person",
          children: [
            { "source.rdb": { name: "src", "@table": "people" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "code" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Visit",
          children: [
            { "source.rdb": { name: "src", "@table": "visits" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "personCode" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            { "identity.reference": { name: "ref_person", "@fields": ["personCode"], "@references": "Person.code" } },
          ],
        },
      },
    ],
  },
});

async function project(migrate: Record<string, unknown> = { dialect: "sqlite" }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fk-target-unique-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.platform.json"), MODEL, "utf8");
  await mkdir(join(root, ".metaobjects", "migrations"), { recursive: true });
  await writeFile(join(root, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, migrate }), "utf8");
  return root;
}

let out: string[] = [];
let infoSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  out = [];
  infoSpy = spyOn(log, "info").mockImplementation((m: string) => { out.push(String(m)); });
  errSpy = spyOn(log, "error").mockImplementation((m: string) => { out.push(String(m)); });
  warnSpy = spyOn(log, "warn").mockImplementation((m: string) => { out.push(String(m)); });
});
afterEach(() => { infoSpy.mockRestore(); errSpy.mockRestore(); warnSpy.mockRestore(); });

describe("meta migrate on SQLite: an FK to a non-unique target is warned, not refused", () => {
  // SQLite accepts the CREATE TABLE and checks the FK only on a write with PRAGMA
  // foreign_keys on, so a refusal here would stop an estate that works (CR-9).
  test("the reference and the fix are named, and the migration is still planned", async () => {
    const root = await project();
    const code = await migrateCommand(["--from-db", "--db", `file:${join(root, "t.db")}`, "--dialect", "sqlite", "--dry-run"], root);

    const text = out.join("\n");
    expect(code).toBe(0);
    expect(text).toContain('reference "ref_person" targets [code] on "Person"');
    expect(text).toContain("identity.secondary");
    expect(text).toContain("PRAGMA foreign_keys");
    expect(text).not.toContain("unexpected error");
    expect(text).toContain('CREATE TABLE "visits"');
  });
});

const PG_URL = process.env.MIGRATE_TS_PG_URL;

async function withPgDatabase(fn: (url: string) => Promise<void>): Promise<void> {
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  const db = `mt_fkt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await admin.query(`CREATE DATABASE ${db}`);
  const url = new URL(PG_URL!);
  url.pathname = `/${db}`;
  try {
    await fn(url.toString());
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }
}

describe("meta migrate on Postgres refuses an FK to a non-unique target (env-gated)", () => {
  if (PG_URL === undefined || PG_URL.length === 0) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    return;
  }

  test("exits 1 with the reference named and the fix, not as an unexpected error", async () => {
    await withPgDatabase(async (url) => {
      const root = await project({ dialect: "postgres" });
      const code = await migrateCommand(["--from-db", "--db", url, "--dialect", "postgres", "--dry-run"], root);

      const text = out.join("\n");
      expect(code).toBe(1);
      expect(text).toContain('reference "ref_person" targets [code] on "Person"');
      expect(text).toContain("identity.secondary");
      expect(text).not.toContain("unexpected error");
      expect(text).not.toContain("CREATE TABLE");
    });
  });

  test("a holder outside migrate.scope is not this run's to fix: warned, and the run goes on", async () => {
    await withPgDatabase(async (url) => {
      const root = await project({ dialect: "postgres", scope: ["acme::platform::Person"] });
      const code = await migrateCommand(["--from-db", "--db", url, "--dialect", "postgres", "--dry-run"], root);

      const text = out.join("\n");
      expect(code).toBe(0);
      expect(text).toContain('reference "ref_person" targets [code] on "Person"');
      expect(text).toContain("not governed by this run");
    });
  });
});
