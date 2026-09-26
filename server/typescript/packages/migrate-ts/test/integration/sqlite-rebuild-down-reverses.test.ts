/**
 * The down of a SQLite table rebuild is a REAL reverse rebuild.
 *
 * It used to be a comment block ("best-effort … reverse the column type/nullable/default
 * changes by hand") that reversed nothing: a rebuild that renamed a column, added one and
 * swapped the CHECK named after the renamed column rolled back to a table still carrying
 * the new name, the new column and the new CHECK — while the ledger said it was undone.
 *
 * Gate, on a real engine: apply → re-diff empty (idempotence) → rollback through the
 * runner → the live schema re-diffs EMPTY against the pre-migration metadata, and the rows
 * survive the round trip under their old column names.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
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
import { applyPending, rollbackTo } from "../../src/apply/apply.js";
import type { SchemaSnapshot } from "../../src/types.js";

interface Shape {
  /** Physical column of the enum field (the CHECK is named after it). */
  kindColumn: string;
  /** Whether the nullable `microchip` column exists. */
  microchip: boolean;
  /** Whether `name` is required. */
  nameRequired: boolean;
}

const BEFORE: Shape = { kindColumn: "species", microchip: false, nameRequired: true };
const AFTER: Shape = { kindColumn: "kind", microchip: true, nameRequired: false };

function model(s: Shape): string {
  return JSON.stringify({
    "metadata.root": {
      package: "clinic",
      children: [
        {
          "object.entity": {
            name: "Owner",
            children: [
              { "source.rdb": { "@table": "owners" } },
              { "field.long": { name: "id" } },
              { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            ],
          },
        },
        {
          "object.entity": {
            name: "Pet",
            children: [
              { "source.rdb": { "@table": "pets" } },
              { "field.long": { name: "id" } },
              { "field.long": { name: "ownerId", "@required": true } },
              { "field.string": { name: "name", "@maxLength": 60, ...(s.nameRequired ? { "@required": true } : {}) } },
              { "field.enum": { name: "kind", "@column": s.kindColumn, "@required": true, "@values": ["dog", "cat"] } },
              ...(s.microchip ? [{ "field.string": { name: "microchip", "@maxLength": 15 } }] : []),
              { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
              { "identity.secondary": { name: "pets_by_name", "@fields": ["name"] } },
              { "identity.reference": { name: "ownerRef", "@fields": ["ownerId"], "@references": "Owner" } },
            ],
          },
        },
      ],
    },
  });
}

async function expectedFor(s: Shape): Promise<SchemaSnapshot> {
  const loaded = await new MetaDataLoader().load([new InMemoryStringSource(model(s))]);
  expect(loaded.errors).toEqual([]);
  return buildExpectedSchema(loaded.root, { dialect: "sqlite" });
}

const RENAME_KIND = { kind: "column", table: "pets", from: "species", to: "kind" } as const;

describe("SQLite rebuild down is a real reverse rebuild", () => {
  let tmp: string;
  let migDir: string;
  let k: Kysely<Record<string, unknown>>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "migrate-ts-rebuild-down-"));
    migDir = join(tmp, "migrations");
    mkdirSync(migDir, { recursive: true });
    k = new Kysely({ dialect: new LibsqlDialect({ url: `file:${join(tmp, "t.db")}` }) });
  });
  afterEach(async () => {
    await k.destroy();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Diff live DB → expected, emit, write as the next migration, apply through the runner. */
  const migrate = async (name: string, expected: SchemaSnapshot, renames: readonly (typeof RENAME_KIND)[] = []) => {
    const actual = await introspectSqlite(k);
    const d = await diff({ expected, actual, dialect: "sqlite", renames });
    expect(d.blocked).toEqual([]);
    const out = emit(d.changes, {
      dialect: "sqlite", expectedSchema: expected, actualSchema: actual,
      ...(actual.meta !== undefined && { actualMeta: actual.meta }),
    });
    mkdirSync(join(migDir, name), { recursive: true });
    writeFileSync(join(migDir, name, "up.sql"), out.up);
    writeFileSync(join(migDir, name, "down.sql"), out.down);
    await applyPending(k, migDir, { dryRun: false });
    return out;
  };
  const rediff = async (expected: SchemaSnapshot) =>
    (await diff({ expected, actual: await introspectSqlite(k), dialect: "sqlite" })).changes;

  test("rename + add column + CHECK swap + nullability: rollback restores the exact previous schema and the rows", async () => {
    const before = await expectedFor(BEFORE);
    await migrate("20260101000000-init", before);
    await sql.raw(`INSERT INTO owners (id) VALUES (1)`).execute(k);
    await sql.raw(`INSERT INTO pets (id, owner_id, name, species) VALUES (1, 1, 'Rex', 'dog'), (2, 1, 'Tom', 'cat')`).execute(k);

    const after = await expectedFor(AFTER);
    const change = await migrate("20260102000000-change", after, [RENAME_KIND]);
    expect(change.recreatedTables.has("pets")).toBe(true);
    expect(await rediff(after)).toEqual([]);
    const moved = await sql.raw<{ id: number; kind: string }>(`SELECT id, kind FROM pets ORDER BY id`).execute(k);
    expect(moved.rows).toEqual([{ id: 1, kind: "dog" }, { id: 2, kind: "cat" }]);

    // The down rebuilds the previous shape instead of asking for hand work.
    expect(change.down).not.toMatch(/best-effort/i);
    expect(change.down).toContain(`CONSTRAINT "pets_species_chk" CHECK`);

    await rollbackTo(k, migDir, "20260101000000-init");
    expect(await rediff(before)).toEqual([]);
    const back = await sql.raw<{ id: number; name: string; species: string }>(
      `SELECT id, name, species FROM pets ORDER BY id`).execute(k);
    expect(back.rows).toEqual([{ id: 1, name: "Rex", species: "dog" }, { id: 2, name: "Tom", species: "cat" }]);
    // The restored CHECK still bites under the old column name.
    await expect(sql.raw(`INSERT INTO pets (id, owner_id, name, species) VALUES (3, 1, 'X', 'cow')`).execute(k))
      .rejects.toThrow(/CHECK/i);

    // The migration re-applies after its rollback: a true inverse, not a one-way door.
    await applyPending(k, migDir, { dryRun: false });
    expect(await rediff(after)).toEqual([]);
  });

  test("a part that genuinely cannot be reversed is NAMED in the down, with why", async () => {
    const before = await expectedFor(BEFORE);
    await migrate("20260101000000-init", before);
    const after = await expectedFor(AFTER);
    const change = await migrate("20260102000000-change", after, [RENAME_KIND]);
    // `name` went NOT NULL → nullable: a NULL written after the migration cannot be copied back.
    expect(change.down).toMatch(/"name".*NOT NULL/);
    // `microchip` is dropped by the down, and its values with it.
    expect(change.down).toMatch(/"microchip"/);
  });

  test("a column the up DROPPED is named as unrecoverable in the down", async () => {
    const withChip = await expectedFor({ ...BEFORE, microchip: true });
    await migrate("20260101000000-init", withChip);
    // Dropping microchip AND tightening `name` forces a rebuild of the same table.
    const target = await expectedFor({ ...BEFORE, microchip: false, nameRequired: false });
    const actual = await introspectSqlite(k);
    const d = await diff({ expected: target, actual, dialect: "sqlite", allow: { dropColumn: true } });
    const out = emit(d.changes, { dialect: "sqlite", expectedSchema: target, actualSchema: actual });
    expect(out.down).toMatch(/"microchip".*cannot be restored/i);
  });
});
