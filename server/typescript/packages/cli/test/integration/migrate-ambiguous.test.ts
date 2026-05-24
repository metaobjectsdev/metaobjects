import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient } from "@libsql/client";
import { run } from "../../src/index.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");

function setupRepo(): { repo: string; dbUrl: string } {
  const repo = mkdtempSync(join(tmpdir(), "forge-migrate-amb-"));
  cpSync(join(FIXTURES, "trainer-website-meta"), repo, { recursive: true });
  return { repo, dbUrl: `file:${join(repo, "local.db")}` };
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
  await run(["migrate", "--cwd", repo, "--db", dbUrl, "--slug", "initial"]);
  const root = join(repo, ".metaobjects", "migrations");
  const dir = findMigrationDir(root, "initial")!;
  await applyMigration(dbUrl, join(root, dir, "up.sql"));
  return { repo, dbUrl };
}

function renameField(metaPath: string, objectName: string, from: string, to: string): void {
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const root = meta["metadata.root"];
  const obj = root.children.find((c: Record<string, { name: string }>) => c["object.entity"]?.name === objectName);
  for (const child of obj["object.entity"].children) {
    const fieldKey = Object.keys(child).find((k) => k.startsWith("field.") || k === "field");
    if (fieldKey && child[fieldKey]?.name === from) {
      child[fieldKey].name = to;
      if (child[fieldKey]["@column"] !== undefined) {
        child[fieldKey]["@column"] = to.replace(/([A-Z])/g, "_$1").toLowerCase();
      }
    }
  }
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

describe("meta migrate — --on-ambiguous", () => {
  test("default (abort): rename-shaped change → exit 1, no migration directory written", async () => {
    const { repo, dbUrl } = await setupMigratedRepo();
    try {
      renameField(join(repo, "metaobjects", "myapp.json"), "User", "displayName", "displayedName");

      const exit = await run(["migrate", "--cwd", repo, "--db", dbUrl, "--slug", "rename"]);
      expect(exit).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("--on-ambiguous rename: produces single rename-column", async () => {
    const { repo, dbUrl } = await setupMigratedRepo();
    try {
      renameField(join(repo, "metaobjects", "myapp.json"), "User", "displayName", "displayedName");

      const exit = await run([
        "migrate", "--cwd", repo, "--db", dbUrl, "--slug", "rename", "--on-ambiguous", "rename",
      ]);
      expect(exit).toBe(0);

      const root = join(repo, ".metaobjects", "migrations");
      const dir = findMigrationDir(root, "rename");
      expect(dir).toBeDefined();
      const sql = readFileSync(join(root, dir!, "up.sql"), "utf8");
      expect(sql).toMatch(/RENAME COLUMN/i);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("--on-ambiguous drop-add: produces drop + add (requires --allow drop-column)", async () => {
    const { repo, dbUrl } = await setupMigratedRepo();
    try {
      renameField(join(repo, "metaobjects", "myapp.json"), "User", "displayName", "displayedName");

      const exit = await run([
        "migrate", "--cwd", repo, "--db", dbUrl, "--slug", "drop-add", "--on-ambiguous", "drop-add", "--allow", "drop-column",
      ]);
      expect(exit).toBe(0);

      const root = join(repo, ".metaobjects", "migrations");
      const dir = findMigrationDir(root, "drop-add");
      expect(dir).toBeDefined();
      const sql = readFileSync(join(root, dir!, "up.sql"), "utf8");
      expect(sql).toMatch(/DROP COLUMN|RECREATE/i);
      expect(sql).toMatch(/displayed_name/i);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
