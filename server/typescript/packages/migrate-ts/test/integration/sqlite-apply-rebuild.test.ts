/**
 * F1 — a SQLite table-rebuild migration must be APPLIABLE through the runner.
 *
 * The recreate-and-copy recipe (any column type change, CHECK change, FK change, or
 * evolved `field.enum @values`) is emitted as a standalone-runnable script:
 *
 *     PRAGMA foreign_keys = OFF;
 *     BEGIN TRANSACTION;
 *       … create __new_x / copy / drop / rename …
 *     COMMIT;
 *     PRAGMA foreign_keys = ON;
 *
 * `applyPending` runs a migration's statements inside ONE Kysely transaction, so the
 * file's own `BEGIN` was a nested transaction and SQLite rejected it outright:
 *
 *     SQLITE_ERROR: cannot start a transaction within a transaction
 *
 * Net effect: **no table-rebuild migration could be applied at all on sqlite — the
 * scaffold's default dialect** — via `--apply`, `apply-pending`, or under Bun. And the
 * failure landed mid-file, so earlier statements had already run: a fresh adopter widening
 * an enum ended up with a dropped-and-not-recreated dependent view and nothing in the
 * ledger. Found by a from-scratch adopter test, not by this suite.
 *
 * Why this suite missed it: the existing sqlite rebuild tests (check-evolution, index
 * escapes, FK convergence, enum evolution) execute the emitted SQL **statement by
 * statement against the engine directly** — they never go through `applyPending`. They
 * prove the SQL is correct; they cannot prove it is appliable by the tool that ships it.
 * These tests drive the real runner.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspectSqlite } from "../../src/introspect/sqlite.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";
import { applyPending } from "../../src/apply/apply.js";

/** An enum widening — the cheapest change that forces a full table rebuild. */
function meta(values: string[]): string {
  return JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [
        {
          "object.entity": {
            name: "Asset",
            children: [
              { "source.rdb": { "@table": "assets" } },
              { "field.long": { name: "id" } },
              { "field.enum": { name: "kind", "@values": values, "@required": true } },
              { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            ],
          },
        },
      ],
    },
  });
}

describe("F1 — sqlite table-rebuild applies through the runner", () => {
  let dir: string;
  let migDir: string;
  let db: Kysely<Record<string, unknown>>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sqlite-apply-rebuild-"));
    migDir = join(dir, "migrations");
    mkdirSync(migDir, { recursive: true });
    db = new Kysely<Record<string, unknown>>({
      dialect: new LibsqlDialect({ url: `file:${join(dir, "app.db")}` }),
    });
  });

  afterEach(async () => {
    await db.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Write an emitted migration into the ledger-tracked directory layout. */
  function writeMigration(name: string, up: string): void {
    const d = join(migDir, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "up.sql"), up, "utf8");
    writeFileSync(join(d, "down.sql"), "-- no-op\n", "utf8");
  }

  async function emitFor(values: string[], allowDrops: boolean): Promise<string> {
    const loaded = await new MetaDataLoader().load([new InMemoryStringSource(meta(values))]);
    expect(loaded.errors).toEqual([]);
    const expected = buildExpectedSchema(loaded.root, { dialect: "sqlite" });
    const actual = await introspectSqlite(db);
    const d = await diff({
      expected, actual, dialect: "sqlite",
      ...(allowDrops ? { allow: { dropCheck: true, dropIndex: true, typeChange: true } } : {}),
    });
    return emit(d.changes, { dialect: "sqlite", expectedSchema: expected }).up;
  }

  test("REGRESSION: an enum widening applies via applyPending (was: nested-transaction error)", async () => {
    // 1. Initial CREATE TABLE — this always worked.
    writeMigration("20260101000000-init", await emitFor(["IMAGE", "VIDEO"], false));
    await applyPending(db, migDir, { dryRun: false, dialect: "sqlite" });
    await sql.raw(`INSERT INTO "assets" ("kind") VALUES ('IMAGE')`).execute(db);

    // 2. Widen the enum → a recreate-and-copy rebuild, carrying BEGIN/COMMIT.
    const rebuild = await emitFor(["IMAGE", "VIDEO", "DOCUMENT"], true);
    expect(rebuild).toMatch(/BEGIN TRANSACTION/); // the emitted file still owns a transaction…
    writeMigration("20260101000001-widen", rebuild);

    // …and the runner must nonetheless apply it. Pre-fix this threw
    // `cannot start a transaction within a transaction`.
    const res = await applyPending(db, migDir, { dryRun: false, dialect: "sqlite" });
    expect(res.applied).toEqual(["20260101000001-widen"]);

    // The rebuild really happened: the new member inserts, data survived, and the
    // CHECK still rejects a non-member.
    await sql.raw(`INSERT INTO "assets" ("kind") VALUES ('DOCUMENT')`).execute(db);
    const rows = await sql.raw(`SELECT kind FROM "assets" ORDER BY id`).execute(db);
    expect((rows.rows as Array<{ kind: string }>).map((r) => r.kind)).toEqual(["IMAGE", "DOCUMENT"]);
    await expect(
      sql.raw(`INSERT INTO "assets" ("kind") VALUES ('SPREADSHEET')`).execute(db),
    ).rejects.toThrow(/CHECK/i);
  });

  test("CONVERGENCE: re-diffing after the applied rebuild is empty", async () => {
    writeMigration("20260101000000-init", await emitFor(["IMAGE", "VIDEO"], false));
    await applyPending(db, migDir, { dryRun: false, dialect: "sqlite" });
    writeMigration("20260101000001-widen", await emitFor(["IMAGE", "VIDEO", "DOCUMENT"], true));
    await applyPending(db, migDir, { dryRun: false, dialect: "sqlite" });

    const loaded = await new MetaDataLoader().load([
      new InMemoryStringSource(meta(["IMAGE", "VIDEO", "DOCUMENT"])),
    ]);
    const expected = buildExpectedSchema(loaded.root, { dialect: "sqlite" });
    const after = await introspectSqlite(db);
    const reDiff = await diff({ expected, actual: after, dialect: "sqlite" });
    expect(reDiff.changes.map((c) => c.kind)).toEqual([]);
  });

  test("ATOMICITY: a failing rebuild leaves NOTHING applied and NOTHING in the ledger", async () => {
    // The original bug aborted mid-file, stranding the database. Whatever else changes,
    // a failed migration must not leave a partially-applied schema.
    writeMigration("20260101000000-init", await emitFor(["IMAGE", "VIDEO"], false));
    await applyPending(db, migDir, { dryRun: false, dialect: "sqlite" });

    // A rebuild whose final statement is invalid: the drop/rename must roll back with it.
    const broken = `${await emitFor(["IMAGE", "VIDEO", "DOCUMENT"], true)}\nSELECT this_column_does_not_exist FROM assets;`;
    writeMigration("20260101000001-broken", broken);
    await expect(applyPending(db, migDir, { dryRun: false, dialect: "sqlite" })).rejects.toThrow();

    // The table is intact and still the ORIGINAL shape — no half-rebuild.
    await expect(
      sql.raw(`INSERT INTO "assets" ("kind") VALUES ('DOCUMENT')`).execute(db),
    ).rejects.toThrow(/CHECK/i);
    const rows = await sql.raw(`SELECT COUNT(*) AS c FROM "assets"`).execute(db);
    expect(Number((rows.rows as Array<{ c: number }>)[0]?.c)).toBe(0);
  });
});
