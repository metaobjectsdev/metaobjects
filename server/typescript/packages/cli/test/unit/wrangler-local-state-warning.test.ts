/**
 * #225 — `isWranglerLocalD1StatePath` pure-function tests, plus one integration
 * check that `meta verify --db` actually emits the warning when pointed at a
 * wrangler local D1 state file, and stays silent for an ordinary `file:` path.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { isWranglerLocalD1StatePath } from "../../src/lib/wrangler.js";
import { run } from "../../src/index.js";

describe("isWranglerLocalD1StatePath", () => {
  test("fires for a realistic wrangler local D1 state path", () => {
    expect(isWranglerLocalD1StatePath("file:.wrangler/state/v3/d1/miniflare-D1DatabaseObject/abc123.sqlite")).toBe(true);
  });
  test("fires with an absolute path prefix", () => {
    expect(isWranglerLocalD1StatePath("file:/srv/app/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/abc123.sqlite")).toBe(true);
  });
  test("fires regardless of the state-version segment between state/ and d1/", () => {
    expect(isWranglerLocalD1StatePath("file:.wrangler/state/v9/d1/x.sqlite")).toBe(true);
  });
  test("does NOT fire for an ordinary file: path", () => {
    expect(isWranglerLocalD1StatePath("file:./local.db")).toBe(false);
    expect(isWranglerLocalD1StatePath("file:/tmp/some-project/local.db")).toBe(false);
  });
  test("does NOT fire for a non-file: URL", () => {
    expect(isWranglerLocalD1StatePath("libsql://example.turso.io")).toBe(false);
    expect(isWranglerLocalD1StatePath("postgres://localhost/db")).toBe(false);
  });
  test("does NOT fire for .wrangler paths that aren't the D1 state directory", () => {
    expect(isWranglerLocalD1StatePath("file:.wrangler/tmp/deploy-abc/worker.js")).toBe(false);
    expect(isWranglerLocalD1StatePath("file:.wrangler/state/v3/kv/some-namespace.sqlite")).toBe(false);
  });
});

function metaJson(): string {
  return JSON.stringify({
    "metadata.root": {
      package: "acme::wranglerwarn",
      children: [{
        "object.entity": {
          name: "Widget",
          children: [
            { "source.rdb": {} },
            { "field.long": { name: "id" } },
            { "field.string": { name: "name", "@column": "name" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      }],
    },
  });
}

async function applyMigration(dbUrl: string, sqlPath: string): Promise<void> {
  const sql = readFileSync(sqlPath, "utf8");
  const client = createClient({ url: dbUrl });
  for (const stmt of sql.split(";").map((s) => s.trim()).filter((s) => s.length > 0)) {
    await client.execute(stmt);
  }
  client.close();
}

async function materialize(repo: string, dbUrl: string): Promise<void> {
  const exit = await run(["migrate", "--from-db", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite", "--slug", "initial"]);
  expect(exit).toBe(0);
  const migrationsRoot = join(repo, ".metaobjects", "migrations");
  const dir = readdirSync(migrationsRoot).find((s) => s.endsWith("-initial"))!;
  await applyMigration(dbUrl, join(migrationsRoot, dir, "up.sql"));
}

let out: string[];
let err: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  out = [];
  err = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

describe("meta verify --db — wrangler local D1 state warning (integration)", () => {
  test("--db pointed inside .wrangler/state/**/d1/** → warns, but still verifies (exit 0 when in sync)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "metaobjects-verify-wrangler-warn-"));
    try {
      mkdirSync(join(repo, "metaobjects"), { recursive: true });
      writeFileSync(join(repo, "metaobjects", "meta.widget.json"), metaJson(), "utf8");
      const stateDir = join(repo, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
      mkdirSync(stateDir, { recursive: true });
      const dbUrl = `file:${join(stateDir, "mock.sqlite")}`;

      await materialize(repo, dbUrl);

      const exit = await run(["verify", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite"]);
      expect(exit).toBe(0);
      const all = [...out, ...err].join("\n");
      expect(all).toContain("wrangler local D1 state directory");
      expect(all).toContain("--dialect d1");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("--db pointed at an ordinary file: path → no warning", async () => {
    const repo = mkdtempSync(join(tmpdir(), "metaobjects-verify-no-warn-"));
    try {
      mkdirSync(join(repo, "metaobjects"), { recursive: true });
      writeFileSync(join(repo, "metaobjects", "meta.widget.json"), metaJson(), "utf8");
      const dbUrl = `file:${join(repo, "local.db")}`;

      await materialize(repo, dbUrl);

      const exit = await run(["verify", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite"]);
      expect(exit).toBe(0);
      const all = [...out, ...err].join("\n");
      expect(all).not.toContain("wrangler local D1 state directory");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
