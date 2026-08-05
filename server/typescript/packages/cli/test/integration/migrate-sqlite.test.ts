import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient } from "@libsql/client";
import { run } from "../../src/index.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");

function setupRepo(): { repo: string; dbPath: string; dbUrl: string } {
  const repo = mkdtempSync(join(tmpdir(), "forge-migrate-sqlite-"));
  cpSync(join(FIXTURES, "trainer-website-meta"), repo, { recursive: true });
  const dbPath = join(repo, "local.db");
  const dbUrl = `file:${dbPath}`;
  return { repo, dbPath, dbUrl };
}

async function applyMigration(dbUrl: string, sqlPath: string): Promise<void> {
  const sql = readFileSync(sqlPath, "utf8");
  const client = createClient({ url: dbUrl });
  const stmts = sql.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
  for (const stmt of stmts) {
    await client.execute(stmt);
  }
  client.close();
}

/**
 * Migration directories only — `.metaobjects/migrations/` also holds the committed
 * `.schema.<dialect>.json` snapshot, which is metaobjects' own state, not a migration.
 */
function migrationDirs(migrationsRoot: string): string[] {
  return readdirSync(migrationsRoot).filter((e) => !e.startsWith("."));
}

function findMigrationDir(migrationsRoot: string, slug: string): string {
  const subdirs = readdirSync(migrationsRoot);
  const match = subdirs.find((s) => s.endsWith(`-${slug}`));
  if (match === undefined) {
    throw new Error(`no migration dir matching slug '${slug}' in ${migrationsRoot}; saw: ${subdirs.join(", ")}`);
  }
  return join(migrationsRoot, match);
}

describe("meta migrate — sqlite end-to-end round-trip", () => {
  test("empty DB → migrate writes CREATE TABLE; apply; re-migrate yields no changes", async () => {
    const { repo, dbUrl } = setupRepo();
    try {
      const exit1 = await run(["migrate", "--from-db", "--cwd", repo, "--db", dbUrl, "--slug", "initial"]);
      expect(exit1).toBe(0);

      const migrationsRoot = join(repo, ".metaobjects", "migrations");
      expect(existsSync(migrationsRoot)).toBe(true);
      const migrationDir = findMigrationDir(migrationsRoot, "initial");
      const upSql = readFileSync(join(migrationDir, "up.sql"), "utf8");

      expect(upSql).toMatch(/CREATE TABLE.*users/i);
      expect(upSql).toMatch(/CREATE TABLE.*posts/i);
      expect(upSql).toMatch(/CREATE TABLE.*tags/i);

      await applyMigration(dbUrl, join(migrationDir, "up.sql"));

      const exit2 = await run(["migrate", "--from-db", "--cwd", repo, "--db", dbUrl]);
      expect(exit2).toBe(0);
      // No new migration should have been created (still just the one)
      expect(migrationDirs(migrationsRoot).length).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("mutated metadata yields single add-column migration", async () => {
    const { repo, dbUrl } = setupRepo();
    try {
      await run(["migrate", "--from-db", "--cwd", repo, "--db", dbUrl, "--slug", "initial"]);
      const migrationsRoot = join(repo, ".metaobjects", "migrations");
      const initialDir = findMigrationDir(migrationsRoot, "initial");
      await applyMigration(dbUrl, join(initialDir, "up.sql"));

      const metaPath = join(repo, "metaobjects", "myapp.json");
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      const root = meta["metadata.root"];
      const user = root.children.find((c: Record<string, { name: string }>) => c["object.entity"]?.name === "User");
      user["object.entity"].children.push({
        "field.string": { name: "bio", "@column": "bio" },
      });
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));

      const exit = await run(["migrate", "--from-db", "--cwd", repo, "--db", dbUrl, "--slug", "add-user-bio"]);
      expect(exit).toBe(0);

      const newDir = findMigrationDir(migrationsRoot, "add-user-bio");
      const sql = readFileSync(join(newDir, "up.sql"), "utf8");
      expect(sql).toMatch(/ALTER TABLE.*users.*ADD COLUMN.*bio/i);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("--slug missing with changes pending → exit 2 with helpful error", async () => {
    const { repo, dbUrl } = setupRepo();
    try {
      const exit = await run(["migrate", "--from-db", "--cwd", repo, "--db", dbUrl]);
      expect(exit).toBe(2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("no changes → exit 0, no new migration directory created", async () => {
    const { repo, dbUrl } = setupRepo();
    try {
      await run(["migrate", "--from-db", "--cwd", repo, "--db", dbUrl, "--slug", "initial"]);
      const migrationsRoot = join(repo, ".metaobjects", "migrations");
      const initialDir = findMigrationDir(migrationsRoot, "initial");
      await applyMigration(dbUrl, join(initialDir, "up.sql"));

      const exit = await run(["migrate", "--from-db", "--cwd", repo, "--db", dbUrl]);
      expect(exit).toBe(0);

      expect(migrationDirs(migrationsRoot).length).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
