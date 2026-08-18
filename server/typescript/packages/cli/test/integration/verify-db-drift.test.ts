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
    { "source.rdb": {} },
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

  // #208 — an @unmanaged DB object (Flyway / a hand-migration owns its DDL) must be
  // INVISIBLE to `verify --db`: its out-of-band presence in the DB is NOT drift (it is
  // threaded out of computeDrift via collectUnmanagedNames), and verify annotates it as
  // external. Without the exclusion the extra table surfaces as a spurious drop-table
  // drift → exit 1. Uses an @unmanaged TABLE (the Flyway-owned-entity case).
  test("@unmanaged DB object present out-of-band → NOT drift; exit 0 + annotated external", async () => {
    const repo = mkdtempSync(join(tmpdir(), "metaobjects-verify-db-unmanaged-"));
    const dbUrl = `file:${join(repo, "local.db")}`;
    // Widget is managed; Legacy is an @unmanaged table (Flyway / a hand-migration owns it).
    const meta = JSON.stringify({
      "metadata.root": {
        package: "acme::drift",
        children: [
          { "object.entity": { name: "Widget", children: [
            { "source.rdb": {} },
            { "field.long": { name: "id" } },
            { "field.string": { name: "name", "@column": "name" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ] } },
          { "object.entity": { name: "Legacy", children: [
            { "source.rdb": { "@table": "legacy_accounts", "@unmanaged": true } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ] } },
        ],
      },
    });
    try {
      mkdirSync(join(repo, "metaobjects"), { recursive: true });
      writeFileSync(join(repo, "metaobjects", "meta.drift.json"), meta, "utf8");
      // Materialize: creates `widgets`, and NEVER the @unmanaged legacy_accounts.
      await materialize(repo, dbUrl);
      // Flyway creates the table out-of-band — it now EXISTS in the DB but is unmodeled-as-managed.
      const client = createClient({ url: dbUrl });
      await client.execute(`CREATE TABLE legacy_accounts ("id" integer PRIMARY KEY)`);
      client.close();

      const exit = await run(["verify", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite"]);
      // The @unmanaged table is excluded from the drift comparison → in sync → exit 0.
      expect(exit).toBe(0);
      // ...and it is annotated as external rather than vanishing silently.
      const all = [...out, ...err].join("\n");
      expect(all).toContain("legacy_accounts");
      expect(all).toContain("external");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// -- #292: the committed snapshot is itself drift ---------------------------
// `meta migrate` diffs metadata against `.metaobjects/migrations/.schema.<dialect>.json`
// by default (`--from-db` is the documented opt-out). Nothing checked that file, so a
// snapshot gone stale — an interrupted migrate, a rollback, a bad merge resolution —
// passed verify clean and made the NEXT migrate emit DDL that fails at apply.
describe("meta verify --db — the committed schema snapshot (#292)", () => {
  const snapshotFile = (repo: string) =>
    join(repo, ".metaobjects", "migrations", ".schema.sqlite.json");

  /** Drop a column from the committed snapshot, standing in for any cause of staleness. */
  function staleSnapshot(repo: string, table: string, column: string): void {
    const path = snapshotFile(repo);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    const t = doc.snapshot.tables.find((x: { name: string }) => x.name === table);
    if (!t) throw new Error(`no table '${table}'; have: ${doc.snapshot.tables.map((x: {name:string}) => x.name).join(', ')}`);
    const before = t.columns.length;
    t.columns = t.columns.filter((c: { name: string }) => c.name !== column);
    expect(t.columns.length).toBe(before - 1);
    writeFileSync(path, JSON.stringify(doc, null, 2), "utf8");
  }

  test("a stale snapshot fails the gate and names the disagreement", async () => {
    const { repo, dbUrl } = scaffold(true);
    try {
      await materialize(repo, dbUrl);
      // Baseline: everything agrees.
      expect(await run(["verify", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite"])).toBe(0);

      staleSnapshot(repo, "widgets", "color");
      out = [];
      err = [];

      const exit = await run(["verify", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite"]);
      expect(exit).toBe(1);
      const all = [...out, ...err].join("\n");
      expect(all).toContain("snapshot");
      expect(all).toContain("color");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("no snapshot on disk → silent, not a failure (fail open)", async () => {
    const { repo, dbUrl } = scaffold(true);
    try {
      await materialize(repo, dbUrl);
      rmSync(snapshotFile(repo), { force: true });
      out = [];
      err = [];
      const exit = await run(["verify", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite"]);
      expect(exit).toBe(0);
      expect([...out, ...err].join("\n")).not.toContain("snapshot");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("an UNAPPLIED migration is not snapshot drift — the snapshot legitimately leads the DB", async () => {
    const { repo, dbUrl } = scaffold(false);
    try {
      await materialize(repo, dbUrl);
      // Metadata gains a column and a migration is GENERATED but never applied. The
      // snapshot advances at generation time, so snapshot != DB on purpose here. The
      // metadata-vs-DB gate must still fire; the snapshot gate must stay quiet.
      writeFileSync(join(repo, "metaobjects", "meta.drift.json"), metaJson(true), "utf8");
      expect(
        await run(["migrate", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite", "--slug", "add-color"]),
      ).toBe(0);
      out = [];
      err = [];

      await run(["verify", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite"]);
      const all = [...out, ...err].join("\n");
      expect(all).not.toContain("snapshot disagrees");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// -- #297: the snapshot check must run the same dialect-aware pipeline migrate runs --
// `checkCommittedSnapshot` receives `dialect`, uses it to pick the snapshot file, then
// omitted it from the `diff()` that does the work. `DiffArgs.dialect` is optional, so the
// wrong call was silently accepted rather than rejected.
//
// The two costs run in opposite directions. On Postgres every view reported drift
// forever: an undefined dialect skips the fingerprint comparison and falls through to
// comparing our emitter's view body against `pg_get_viewdef`'s deparse — two strings that
// can never be equal, which is the exact failure the fingerprint was introduced to end.
// And CHECK constraints were never diffed at all, because `diffTables` gates that pass on
// the dialect being known — a false NEGATIVE, the dangerous direction for a gate.
//
// Pinned here on the CHECK arm, which needs no Postgres container and is the false
// NEGATIVE — a gate reporting "in sync" over a schema whose constraints have moved.
describe("meta verify --db — the snapshot check is dialect-aware (#297)", () => {
  /** metaJson's shape plus a `field.enum`, whose `@values` become a CHECK constraint. */
  function metaJsonEnum(): string {
    return JSON.stringify({
      "metadata.root": {
        package: "acme::drift",
        children: [
          {
            "object.entity": {
              name: "Widget",
              children: [
                { "source.rdb": {} },
                { "field.long": { name: "id" } },
                { "field.string": { name: "name", "@column": "name" } },
                { "field.enum": { name: "status", "@column": "status", "@values": ["DRAFT", "LIVE"] } },
                { "identity.primary": { name: "pk", "@fields": ["id"] } },
              ],
            },
          },
        ],
      },
    });
  }

  /**
   * Move the committed snapshot's CHECK expression away from the one the DB enforces.
   *
   * Stands in for any cause of constraint staleness — an interrupted migrate, a bad merge
   * resolution — exactly as `staleSnapshot` above does for a column. Only the SNAPSHOT is
   * touched: metadata and DB still agree, which is the precondition that lets the snapshot
   * pass run at all.
   */
  function staleSnapshotCheck(repo: string): void {
    const path = join(repo, ".metaobjects", "migrations", ".schema.sqlite.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    const t = doc.snapshot.tables.find((x: { name: string }) => x.name === "widgets");
    if (!t) throw new Error(`no table 'widgets'; have: ${doc.snapshot.tables.map((x: {name:string}) => x.name).join(", ")}`);
    // Asserted, not assumed: with no check to make stale the test would pass vacuously.
    expect(t.checks.length).toBeGreaterThan(0);
    t.checks = t.checks.map((c: { expression: string }) => ({
      ...c,
      expression: c.expression.replace("DRAFT", "RETIRED"),
    }));
    writeFileSync(path, JSON.stringify(doc, null, 2), "utf8");
  }

  test("a stale CHECK in the snapshot fails the gate rather than passing silently", async () => {
    const repo = mkdtempSync(join(tmpdir(), "metaobjects-verify-297-"));
    const dbUrl = `file:${join(repo, "local.db")}`;
    try {
      mkdirSync(join(repo, "metaobjects"), { recursive: true });
      writeFileSync(join(repo, "metaobjects", "meta.drift.json"), metaJsonEnum(), "utf8");
      expect(
        await run(["migrate", "--from-db", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite", "--slug", "initial"]),
      ).toBe(0);
      const migrationsRoot = join(repo, ".metaobjects", "migrations");
      const dir = readdirSync(migrationsRoot).find((s) => s.endsWith("-initial"))!;
      await applyMigration(dbUrl, join(migrationsRoot, dir, "up.sql"));
      // Baseline: everything agrees, including the constraint.
      expect(await run(["verify", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite"])).toBe(0);

      staleSnapshotCheck(repo);
      out = [];
      err = [];

      const exit = await run(["verify", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite"]);
      const all = [...out, ...err].join("\n");
      expect(all).toContain("snapshot");
      expect(exit).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
