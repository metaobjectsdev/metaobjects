/**
 * Bug gate: SQLite stores NO foreign-key constraint names (the emitter writes
 * unnamed `FOREIGN KEY (…) REFERENCES …` clauses; pragma_foreign_key_list has no
 * name column), so introspection SYNTHESIZES `<table>_<cols.join("_")>_fk` while
 * the expected side derives `<table>_<firstCol>_fk` — or honours @constraintName.
 * Any composite FK (2-column: `t_a_fk` vs `t_a_b_fk`) and EVERY @constraintName
 * therefore mismatched by name forever: the diff proposed drop-fk (blocked →
 * `meta migrate` exits 1 forever; or, with allow.dropFk, a recreate-and-copy of
 * the table on every single run).
 *
 * Fix under test: on sqlite/d1 the diff matches FKs STRUCTURALLY (by column set)
 * and ignores names — the engine doesn't store them, so a name can never be a
 * real difference there.
 *
 * Real-engine gate: full pipeline against libsql → apply → re-diff EMPTY.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspectSqlite } from "../../src/introspect/sqlite.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";

const META = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "Region",
          children: [
            { "source.rdb": {} },
            { "field.string": { name: "code", "@required": true } },
            { "field.string": { name: "country", "@required": true } },
            // Composite primary key — the referenced side of the composite FK.
            { "identity.primary": { name: "pk", "@fields": ["code", "country"] } },
          ],
        },
      },
      {
        "object.entity": {
          name: "City",
          children: [
            { "source.rdb": {} },
            { "field.long": { name: "id" } },
            { "field.string": { name: "regionCode", "@required": true } },
            { "field.string": { name: "regionCountry", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            // COMPOSITE FK: expected name `cities_region_code_fk` (first column only)
            // vs introspection's synthesized `cities_region_code_region_country_fk`.
            {
              "identity.reference": {
                name: "fk_region",
                "@fields": ["regionCode", "regionCountry"],
                "@references": "Region.code,country",
              },
            },
          ],
        },
      },
      {
        "object.entity": {
          name: "Landmark",
          children: [
            { "source.rdb": {} },
            { "field.long": { name: "id" } },
            { "field.long": { name: "cityId", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            // @constraintName — whose whole purpose is adopting an existing DB's
            // FK name — can NEVER equal the sqlite-synthesized name.
            {
              "identity.reference": {
                name: "fk_city",
                "@fields": ["cityId"],
                "@references": "City",
                "@constraintName": "fk_landmark_belongs_to_city",
              },
            },
          ],
        },
      },
    ],
  },
});

let tmpDir: string;
let k: Kysely<Record<string, unknown>>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "migrate-ts-fk-convergence-"));
  k = new Kysely({ dialect: new LibsqlDialect({ url: `file:${join(tmpDir, "t.db")}` }) });
});
afterEach(async () => {
  await k.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function applyRaw(sqlText: string): Promise<void> {
  for (const stmt of sqlText.trim().split(";").map((s) => s.trim()).filter(Boolean)) {
    await sql.raw(stmt).execute(k);
  }
}

describe("SQLite FK convergence — composite FKs and @constraintName", () => {
  test("apply from empty, then re-diff is EMPTY (no phantom drop-fk/add-fk)", async () => {
    const root = (await new MetaDataLoader().load([new InMemoryStringSource(META)])).root;
    const expected = buildExpectedSchema(root, { dialect: "sqlite" });
    const actual0 = await introspectSqlite(k);
    const initial = await diff({ expected, actual: actual0, dialect: "sqlite" });
    expect(initial.blocked).toEqual([]);
    const { up } = emit(initial.changes, {
      dialect: "sqlite",
      expectedSchema: expected,
      ...(actual0.meta !== undefined && { actualMeta: actual0.meta }),
    });
    await applyRaw(up);

    // The FK actually works on the live engine (not just present in a catalog):
    await sql.raw("PRAGMA foreign_keys = ON").execute(k);
    await sql.raw(`INSERT INTO "regions" ("code", "country") VALUES ('BY', 'DE')`).execute(k);
    await sql.raw(
      `INSERT INTO "cities" ("id", "region_code", "region_country") VALUES (1, 'BY', 'DE')`,
    ).execute(k);
    await expect(
      sql.raw(`INSERT INTO "cities" ("id", "region_code", "region_country") VALUES (2, 'XX', 'YY')`).execute(k),
    ).rejects.toThrow(/FOREIGN KEY/i);

    const followup = await diff({ expected, actual: await introspectSqlite(k), dialect: "sqlite" });
    if (followup.changes.length > 0) {
      console.error("ROUND-TRIP FAILURE — a second `meta migrate` would emit:");
      for (const c of followup.changes) console.error("  -", JSON.stringify(c));
    }
    expect(followup.changes).toEqual([]);
  });
});
