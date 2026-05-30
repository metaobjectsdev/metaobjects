/**
 * meta verify --db — schema-drift gate (Phase 2 Unit 2).
 *
 * Materializes a metadata-declared schema into a sqlite file (via `meta migrate`
 * + applying the emitted up.sql), then asserts:
 *   - in-sync DB → exit 0;
 *   - drifted DB (metadata gained a column the DB lacks) → exit 1 + drift printed;
 *   - no --db → schema path skipped entirely (exit reflects template path only).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { run } from "../../src/index.js";

function metaJson(withColor: boolean): string {
  const widgetChildren: Record<string, unknown>[] = [
    { "field.long": { name: "id" } },
    { "field.string": { name: "name", "@column": "name" } },
  ];
  if (withColor) {
    widgetChildren.push({ "field.string": { name: "color", "@column": "color" } });
  }
  widgetChildren.push({ "identity.primary": { name: "pk", "@fields": ["id"] } });
  return JSON.stringify({
    "metadata.root": {
      package: "acme::drift",
      children: [{ "object.entity": { name: "Widget", children: widgetChildren } }],
    },
  });
}

function scaffold(withColor: boolean): { repo: string; dbUrl: string } {
  const repo = mkdtempSync(join(tmpdir(), "metaobjects-verify-db-"));
  mkdirSync(join(repo, "metaobjects"), { recursive: true });
  writeFileSync(join(repo, "metaobjects", "meta.drift.json"), metaJson(withColor), "utf8");
  const dbUrl = `file:${join(repo, "local.db")}`;
  return { repo, dbUrl };
}

async function applyMigration(dbUrl: string, sqlPath: string): Promise<void> {
  const sql = readFileSync(sqlPath, "utf8");
  const client = createClient({ url: dbUrl });
  for (const stmt of sql.split(";").map((s) => s.trim()).filter((s) => s.length > 0)) {
    await client.execute(stmt);
  }
  client.close();
}

/** Run migrate to materialize the current metadata schema into the DB. */
async function materialize(repo: string, dbUrl: string): Promise<void> {
  const exit = await run(["migrate", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite", "--slug", "initial"]);
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

describe("meta verify --db — schema-drift gate", () => {
  test("in-sync DB → exit 0", async () => {
    const { repo, dbUrl } = scaffold(true);
    try {
      await materialize(repo, dbUrl);
      const exit = await run(["verify", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite"]);
      expect(exit).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("drifted DB (metadata gained a column) → exit 1 and prints the drift", async () => {
    const { repo, dbUrl } = scaffold(false);
    try {
      // Materialize the reduced schema (no `color`)...
      await materialize(repo, dbUrl);
      // ...then add `color` to the metadata so the DB is now behind.
      writeFileSync(join(repo, "metaobjects", "meta.drift.json"), metaJson(true), "utf8");

      const exit = await run(["verify", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite"]);
      expect(exit).toBe(1);
      const all = [...out, ...err].join("\n");
      expect(all).toContain("color");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("no --db → schema path skipped; exit reflects only the template path (0 here, no templates)", async () => {
    const { repo, dbUrl } = scaffold(true);
    try {
      await materialize(repo, dbUrl);
      // Even though the metadata could drift if checked, with no --db we never look.
      writeFileSync(join(repo, "metaobjects", "meta.drift.json"), metaJson(true), "utf8");
      const exit = await run(["verify", "--cwd", repo]);
      expect(exit).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("--skip-schema with --db → schema gate not run (exit 0 despite drift)", async () => {
    const { repo, dbUrl } = scaffold(false);
    try {
      await materialize(repo, dbUrl);
      writeFileSync(join(repo, "metaobjects", "meta.drift.json"), metaJson(true), "utf8");
      const exit = await run(["verify", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite", "--skip-schema"]);
      expect(exit).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
