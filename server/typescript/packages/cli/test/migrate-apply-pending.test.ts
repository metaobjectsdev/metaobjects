import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { migrateCommand } from "../src/commands/migrate.js";
import { buildKyselyFromUrl } from "../src/lib/kysely.js";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

// A project root with two committed migration files under the default migrations dir.
async function projectWithMigrations(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mts-applypending-"));
  dirs.push(root);
  const migDir = join(root, ".metaobjects", "migrations");
  await mkdir(join(migDir, "0001-init"), { recursive: true });
  await writeFile(join(migDir, "0001-init", "up.sql"),
    `CREATE TABLE "widgets" ("id" integer primary key, "name" text not null);`, "utf8");
  await mkdir(join(migDir, "0002-view"), { recursive: true });
  await writeFile(join(migDir, "0002-view", "up.sql"),
    `CREATE VIEW "widget_names" AS SELECT "name" FROM "widgets";`, "utf8");
  return root;
}

async function relationNames(dbFile: string): Promise<string[]> {
  const k = await buildKyselyFromUrl(`file:${dbFile}`, "sqlite");
  try {
    const rows = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`.execute(k.db);
    return rows.rows.map((r) => r.name);
  } finally {
    await k.close();
  }
}

describe("meta migrate apply-pending", () => {
  test("provisions a fresh DB from committed migrations, ledger-tracked", async () => {
    const root = await projectWithMigrations();
    const db = join(root, "t.db");
    const code = await migrateCommand(["apply-pending", "--db", `file:${db}`, "--dialect", "sqlite"], root);
    expect(code).toBe(0);
    const names = await relationNames(db);
    expect(names).toContain("widgets");
    expect(names).toContain("widget_names");
    expect(names).toContain("_metaobjects_migrations");
  });

  test("is idempotent — a second run applies nothing", async () => {
    const root = await projectWithMigrations();
    const db = join(root, "t.db");
    expect(await migrateCommand(["apply-pending", "--db", `file:${db}`, "--dialect", "sqlite"], root)).toBe(0);
    // Second run: still exit 0, ledger unchanged (2 rows).
    expect(await migrateCommand(["apply-pending", "--db", `file:${db}`, "--dialect", "sqlite"], root)).toBe(0);
    const k = await buildKyselyFromUrl(`file:${db}`, "sqlite");
    try {
      const r = await sql<{ n: number }>`SELECT count(*) AS n FROM _metaobjects_migrations`.execute(k.db);
      expect(Number(r.rows[0]!.n)).toBe(2);
    } finally { await k.close(); }
  });

  test("--dry-run lists pending without applying", async () => {
    const root = await projectWithMigrations();
    const db = join(root, "t.db");
    const code = await migrateCommand(
      ["apply-pending", "--db", `file:${db}`, "--dialect", "sqlite", "--dry-run"], root);
    expect(code).toBe(0);
    // Nothing applied → the widgets table must NOT exist.
    const names = await relationNames(db);
    expect(names).not.toContain("widgets");
  });

  test("missing --db → exit 2", async () => {
    const root = await projectWithMigrations();
    expect(await migrateCommand(["apply-pending", "--dialect", "sqlite"], root)).toBe(2);
  });

  test("d1 is rejected → exit 2", async () => {
    const root = await projectWithMigrations();
    expect(await migrateCommand(["apply-pending", "--dialect", "d1"], root)).toBe(2);
  });

  test("tamper guard surfaces as exit 1", async () => {
    const root = await projectWithMigrations();
    const db = join(root, "t.db");
    expect(await migrateCommand(["apply-pending", "--db", `file:${db}`, "--dialect", "sqlite"], root)).toBe(0);
    // Edit an already-applied up.sql → checksum guard throws → exit 1.
    await writeFile(join(root, ".metaobjects", "migrations", "0001-init", "up.sql"),
      `CREATE TABLE "widgets" ("id" integer primary key, "name" text);`, "utf8");
    expect(await migrateCommand(["apply-pending", "--db", `file:${db}`, "--dialect", "sqlite"], root)).toBe(1);
  });
});
