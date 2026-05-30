import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient } from "@libsql/client";
import { run } from "../../src/index.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");

function setupRepo(): { repo: string; dbUrl: string } {
  const repo = mkdtempSync(join(tmpdir(), "forge-migrate-apply-"));
  cpSync(join(FIXTURES, "trainer-website-meta"), repo, { recursive: true });
  const dbUrl = `file:${join(repo, "local.db")}`;
  return { repo, dbUrl };
}

async function tableNames(dbUrl: string): Promise<Set<string>> {
  const client = createClient({ url: dbUrl });
  const res = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table'",
  );
  client.close();
  return new Set(res.rows.map((r) => String(r.name)));
}

describe("meta migrate --apply — sqlite, ledger-backed", () => {
  test("--apply on fresh DB runs the generated migration; schema exists", async () => {
    const { repo, dbUrl } = setupRepo();
    try {
      const exit = await run([
        "migrate", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite", "--slug", "initial", "--apply",
      ]);
      expect(exit).toBe(0);

      const tables = await tableNames(dbUrl);
      expect(tables.has("users")).toBe(true);
      expect(tables.has("posts")).toBe(true);
      // Ledger table created + populated.
      expect(tables.has("_metaobjects_migrations")).toBe(true);

      const client = createClient({ url: dbUrl });
      const led = await client.execute("SELECT count(*) AS c FROM _metaobjects_migrations");
      client.close();
      expect(Number(led.rows[0]!.c)).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("re-run --apply with no metadata changes is a no-op (ledger skip)", async () => {
    const { repo, dbUrl } = setupRepo();
    try {
      await run(["migrate", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite", "--slug", "initial", "--apply"]);
      const migrationsRoot = join(repo, ".metaobjects", "migrations");
      const before = readdirSync(migrationsRoot).length;

      const exit = await run(["migrate", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite", "--apply"]);
      expect(exit).toBe(0);

      // No new migration dir, ledger still has exactly one row.
      expect(readdirSync(migrationsRoot).length).toBe(before);
      const client = createClient({ url: dbUrl });
      const led = await client.execute("SELECT count(*) AS c FROM _metaobjects_migrations");
      client.close();
      expect(Number(led.rows[0]!.c)).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("--dry-run --apply applies nothing", async () => {
    const { repo, dbUrl } = setupRepo();
    try {
      const exit = await run([
        "migrate", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite", "--slug", "initial", "--apply", "--dry-run",
      ]);
      expect(exit).toBe(0);
      const tables = await tableNames(dbUrl);
      expect(tables.has("users")).toBe(false);
      expect(tables.has("_metaobjects_migrations")).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("--rollback (empty target → everything) reverts schema + clears ledger", async () => {
    const { repo, dbUrl } = setupRepo();
    try {
      const applied = await run([
        "migrate", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite", "--slug", "initial", "--apply",
      ]);
      expect(applied).toBe(0);
      expect((await tableNames(dbUrl)).has("users")).toBe(true);

      // Roll everything back (empty --rollback target === null).
      const rolled = await run([
        "migrate", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite", "--rollback", "",
      ]);
      expect(rolled).toBe(0);

      const tables = await tableNames(dbUrl);
      expect(tables.has("users")).toBe(false);
      expect(tables.has("posts")).toBe(false);
      // Ledger table still exists but is now empty.
      const client = createClient({ url: dbUrl });
      const led = await client.execute("SELECT count(*) AS c FROM _metaobjects_migrations");
      client.close();
      expect(Number(led.rows[0]!.c)).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("--rollback and --apply together → exit 2 (mutually exclusive)", async () => {
    const { repo, dbUrl } = setupRepo();
    try {
      const exit = await run([
        "migrate", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite", "--rollback", "x", "--apply",
      ]);
      expect(exit).toBe(2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
