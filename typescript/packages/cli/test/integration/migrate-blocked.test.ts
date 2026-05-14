import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient } from "@libsql/client";
import { run } from "../../src/index.js";

const FIXTURES = resolve("packages/cli/test/fixtures");

function setupRepo(): { repo: string; dbUrl: string } {
  const repo = mkdtempSync(join(tmpdir(), "forge-migrate-blocked-"));
  cpSync(join(FIXTURES, "downstream-consumer-meta"), repo, { recursive: true });
  return { repo, dbUrl: `file:${join(repo, "local.db")}` };
}

async function runIn<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const orig = process.cwd();
  process.chdir(cwd);
  try { return await fn(); } finally { process.chdir(orig); }
}

async function applyMigration(dbUrl: string, sqlPath: string): Promise<void> {
  const sql = readFileSync(sqlPath, "utf8");
  const client = createClient({ url: dbUrl });
  const stmts = sql.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
  for (const stmt of stmts) await client.execute(stmt);
  client.close();
}

function findMigrationDir(migrationsRoot: string, slug: string): string | undefined {
  const subdirs = readdirSync(migrationsRoot);
  return subdirs.find((s) => s.endsWith(`-${slug}`));
}

async function setupMigratedRepo(): Promise<{ repo: string; dbUrl: string }> {
  const { repo, dbUrl } = setupRepo();
  await runIn(repo, () => run(["migrate", "--db", dbUrl, "--slug", "initial"]));
  const migrationsRoot = join(repo, ".metaobjects", "migrations");
  const initialDir = findMigrationDir(migrationsRoot, "initial")!;
  await applyMigration(dbUrl, join(migrationsRoot, initialDir, "up.sql"));
  return { repo, dbUrl };
}

describe("meta migrate — blocked changes without --allow", () => {
  test("drop-column without --allow drop-column → exit 1, no migration written", async () => {
    const { repo, dbUrl } = await setupMigratedRepo();
    try {
      const metaPath = join(repo, "metaobjects", "myapp.json");
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      const user = meta.metadata.children.find((c: { object?: { name: string } }) => c.object?.name === "User");
      user.object.children = user.object.children.filter(
        (c: { field?: { name: string } }) => c.field?.name !== "displayName",
      );
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));

      const exit = await runIn(repo, () => run(["migrate", "--db", dbUrl, "--slug", "drop-display-name"]));
      expect(exit).toBe(1);

      const migrationsRoot = join(repo, ".metaobjects", "migrations");
      expect(findMigrationDir(migrationsRoot, "drop-display-name")).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("drop-column with --allow drop-column → exit 0, migration written", async () => {
    const { repo, dbUrl } = await setupMigratedRepo();
    try {
      const metaPath = join(repo, "metaobjects", "myapp.json");
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      const user = meta.metadata.children.find((c: { object?: { name: string } }) => c.object?.name === "User");
      user.object.children = user.object.children.filter(
        (c: { field?: { name: string } }) => c.field?.name !== "displayName",
      );
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));

      const exit = await runIn(repo, () => run([
        "migrate", "--db", dbUrl, "--slug", "drop-display-name", "--allow", "drop-column",
      ]));
      expect(exit).toBe(0);

      const migrationsRoot = join(repo, ".metaobjects", "migrations");
      expect(findMigrationDir(migrationsRoot, "drop-display-name")).toBeDefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
