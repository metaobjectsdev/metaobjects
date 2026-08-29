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


/**
 * The same enum widening, but the rebuilt table is REFERENCED by a second, populated
 * table. This is the shape every test above is blind to: `assets` has no referrer, so
 * dropping it can violate nothing.
 */
function metaWithReferrer(values: string[]): string {
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
        {
          "object.entity": {
            name: "AssetTag",
            children: [
              { "source.rdb": { "@table": "asset_tags" } },
              { "field.long": { name: "id" } },
              { "field.long": { name: "assetId", "@required": true } },
              { "field.string": { name: "label", "@required": true } },
              { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
              { "identity.reference": { name: "assetRef", "@fields": ["assetId"], "@references": "Asset" } },
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
    await expect(applyPending(db, migDir, { dryRun: false, dialect: "sqlite" })).rejects.toThrow(
      /no such column: this_column_does_not_exist/i,
    );

    // The table is intact and still the ORIGINAL shape — no half-rebuild.
    await expect(
      sql.raw(`INSERT INTO "assets" ("kind") VALUES ('DOCUMENT')`).execute(db),
    ).rejects.toThrow(/CHECK/i);
    const rows = await sql.raw(`SELECT COUNT(*) AS c FROM "assets"`).execute(db);
    expect(Number((rows.rows as Array<{ c: number }>)[0]?.c)).toBe(0);
  });
});

/**
 * B1 — the rebuilt table is REFERENCED by another populated table.
 *
 * Every test in the block above rebuilds `assets`, which nothing references, so the
 * DROP inside the recreate-and-copy recipe can violate no constraint. That is why they
 * all passed while adoption was broken in the field: the runner rewrote the file's
 * `PRAGMA foreign_keys = OFF` to `PRAGMA defer_foreign_keys = ON`, and deferral is NOT
 * a substitute here. `DROP TABLE assets` records one deferred violation per referencing
 * row; the repair is `ALTER TABLE __new_assets RENAME TO assets`, a RENAME, which never
 * decrements that counter — so COMMIT failed with
 * `SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed`.
 *
 * Found by adopting MetaObjects into an existing three-table app, which is the
 * documented migration path, on the scaffold's default dialect.
 */
describe("B1 — rebuilding a table that another populated table references", () => {
  let dir: string;
  let migDir: string;
  let db: Kysely<Record<string, unknown>>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sqlite-apply-referenced-"));
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

  function writeMigration(name: string, up: string): void {
    const d = join(migDir, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "up.sql"), up, "utf8");
    writeFileSync(join(d, "down.sql"), "-- no-op\n", "utf8");
  }

  async function emitFor(values: string[], allowDrops: boolean): Promise<string> {
    const loaded = await new MetaDataLoader().load([
      new InMemoryStringSource(metaWithReferrer(values)),
    ]);
    expect(loaded.errors).toEqual([]);
    const expected = buildExpectedSchema(loaded.root, { dialect: "sqlite" });
    const actual = await introspectSqlite(db);
    const d = await diff({
      expected, actual, dialect: "sqlite",
      ...(allowDrops ? { allow: { dropCheck: true, dropIndex: true, typeChange: true } } : {}),
    });
    return emit(d.changes, { dialect: "sqlite", expectedSchema: expected }).up;
  }

  test("REGRESSION: the rebuild applies, and every referencing row survives", async () => {
    writeMigration("20260101000000-init", await emitFor(["IMAGE", "VIDEO"], false));
    await applyPending(db, migDir, { dryRun: false, dialect: "sqlite" });

    // Populate BOTH sides. The referencing rows are what deferral could not survive.
    await sql.raw(`INSERT INTO "assets" ("kind") VALUES ('IMAGE'), ('VIDEO')`).execute(db);
    await sql
      .raw(`INSERT INTO "asset_tags" ("asset_id", "label") VALUES (1, 'hero'), (1, 'square'), (2, 'clip')`)
      .execute(db);

    writeMigration("20260101000001-widen", await emitFor(["IMAGE", "VIDEO", "DOCUMENT"], true));

    // Pre-fix: SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed.
    const res = await applyPending(db, migDir, { dryRun: false, dialect: "sqlite" });
    expect(res.applied).toEqual(["20260101000001-widen"]);

    const tags = await sql.raw(`SELECT label FROM "asset_tags" ORDER BY id`).execute(db);
    expect((tags.rows as Array<{ label: string }>).map((r) => r.label)).toEqual([
      "hero", "square", "clip",
    ]);
    const assets = await sql.raw(`SELECT kind FROM "assets" ORDER BY id`).execute(db);
    expect((assets.rows as Array<{ kind: string }>).map((r) => r.kind)).toEqual(["IMAGE", "VIDEO"]);

    // The rebuild really happened, and the FK is still enforced afterwards.
    await sql.raw(`INSERT INTO "assets" ("kind") VALUES ('DOCUMENT')`).execute(db);
    await expect(
      sql.raw(`INSERT INTO "asset_tags" ("asset_id", "label") VALUES (999, 'orphan')`).execute(db),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  test("FK enforcement is RESTORED after the migration, not left off", async () => {
    // The fix disables foreign_keys around the transaction. If it failed to restore it,
    // every later write in the process would silently skip FK checks — worse than the bug.
    writeMigration("20260101000000-init", await emitFor(["IMAGE", "VIDEO"], false));
    await applyPending(db, migDir, { dryRun: false, dialect: "sqlite" });
    await sql.raw(`INSERT INTO "assets" ("kind") VALUES ('IMAGE')`).execute(db);
    writeMigration("20260101000001-widen", await emitFor(["IMAGE", "VIDEO", "DOCUMENT"], true));
    await applyPending(db, migDir, { dryRun: false, dialect: "sqlite" });

    const pragma = await sql.raw(`PRAGMA foreign_keys`).execute(db);
    expect((pragma.rows as Array<Record<string, number>>)[0]?.foreign_keys).toBe(1);
  });

  test("CONVERGENCE: re-diffing after the referenced-table rebuild is empty", async () => {
    writeMigration("20260101000000-init", await emitFor(["IMAGE", "VIDEO"], false));
    await applyPending(db, migDir, { dryRun: false, dialect: "sqlite" });
    await sql.raw(`INSERT INTO "assets" ("kind") VALUES ('IMAGE')`).execute(db);
    await sql.raw(`INSERT INTO "asset_tags" ("asset_id","label") VALUES (1,'hero')`).execute(db);
    writeMigration("20260101000001-widen", await emitFor(["IMAGE", "VIDEO", "DOCUMENT"], true));
    await applyPending(db, migDir, { dryRun: false, dialect: "sqlite" });

    const loaded = await new MetaDataLoader().load([
      new InMemoryStringSource(metaWithReferrer(["IMAGE", "VIDEO", "DOCUMENT"])),
    ]);
    const expected = buildExpectedSchema(loaded.root, { dialect: "sqlite" });
    const after = await introspectSqlite(db);
    const reDiff = await diff({ expected, actual: after, dialect: "sqlite" });
    expect(reDiff.changes.map((c) => c.kind)).toEqual([]);
  });
});
