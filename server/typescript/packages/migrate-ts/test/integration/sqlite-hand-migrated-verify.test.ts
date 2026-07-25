/**
 * SQLite/D1 hand-migrated verify — a hand-written schema must verify CLEAN
 * against metadata whose columns carry sqlite-non-physical annotations.
 *
 * The tool's own emit→introspect→diff round-trips already converge (emit writes
 * VARCHAR(N) / json → introspect reads them back). But a hand-written SQLite/D1
 * migration idiomatically writes bare `TEXT` — no VARCHAR length, and TEXT for a
 * jsonb column (SQLite has no native json type). SQLite does not physically store
 * either distinction (VARCHAR(N) length is cosmetic; json is TEXT-affinity), so a
 * bare-TEXT column IS the maxLength'd / json column. The diff must treat them as
 * equal on sqlite/d1 — otherwise `meta verify --dialect d1` reports permanent,
 * unfixable false drift for every maxLength'd string and every jsonb column.
 *
 * Regression gate for the D1 verify false-drift class (categories 1 + 2).
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

// A hand-migrated table: bare TEXT for a maxLength'd PK, a maxLength'd string, and
// an open-json column — the idiomatic SQLite/D1 spelling, carrying none of the
// non-physical annotations the metadata declares.
const METADATA = JSON.stringify({
  "metadata.root": {
    package: "test",
    children: [
      {
        "object.entity": {
          name: "Doc",
          children: [
            { "source.rdb": { "@table": "docs" } },
            { "field.string": { name: "id", "@maxLength": 8, "@required": true } },
            { "field.string": { name: "title", "@maxLength": 140, "@required": true } },
            { "field.string": { name: "data", "@dbColumnType": "jsonb" } },
            { "identity.primary": { "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
});

const HAND_DDL = `
  CREATE TABLE docs (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    data TEXT
  )
`;

// A hand-migrated table whose enum column carries an ANONYMOUS inline CHECK — the
// idiomatic hand-written spelling (no CONSTRAINT name). SQLite stores no constraint
// identity for it, so it must be matched to the modeled field.enum by expression.
const METADATA_ENUM = JSON.stringify({
  "metadata.root": {
    package: "test",
    children: [
      {
        "object.entity": {
          name: "Item",
          children: [
            { "source.rdb": { "@table": "items" } },
            { "field.string": { name: "id", "@required": true } },
            { "field.enum": { name: "status", "@values": ["open", "closed"], "@required": true } },
            { "identity.primary": { "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
});

// No spaces after the commas — the idiomatic hand-written spelling, which differs
// from the generated `IN ('open', 'closed')` only in comma spacing.
const HAND_DDL_ENUM = `
  CREATE TABLE items (
    id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open','closed'))
  )
`;

let tmpDir: string;
let k: Kysely<Record<string, unknown>>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "migrate-ts-handmig-sqlite-"));
  k = new Kysely({ dialect: new LibsqlDialect({ url: `file:${join(tmpDir, "test.db")}` }) });
});

afterEach(async () => {
  await k.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SQLite/D1 hand-migrated verify — non-physical annotations", () => {
  test("bare-TEXT hand DDL verifies clean against maxLength'd + jsonb metadata", async () => {
    const metadata = (await new MetaDataLoader().load([new InMemoryStringSource(METADATA)])).root;
    const expected = buildExpectedSchema(metadata, { dialect: "sqlite" });
    await sql.raw(HAND_DDL.trim()).execute(k);
    const actual = await introspectSqlite(k);

    const result = await diff({ expected, actual, dialect: "sqlite" });
    if (result.changes.length > 0) {
      console.error("HAND-MIGRATED VERIFY FALSE DRIFT — remaining changes:");
      for (const c of result.changes) console.error(`  - ${c.kind}:`, JSON.stringify(c));
    }
    // No change-column-type for maxLength (id/title) or json (data).
    expect(result.changes).toEqual([]);
  });

  test("anonymous inline CHECK verifies clean against a modeled field.enum", async () => {
    const metadata = (await new MetaDataLoader().load([new InMemoryStringSource(METADATA_ENUM)])).root;
    const expected = buildExpectedSchema(metadata, { dialect: "sqlite" });
    await sql.raw(HAND_DDL_ENUM.trim()).execute(k);
    const actual = await introspectSqlite(k);

    const result = await diff({ expected, actual, dialect: "sqlite" });
    if (result.changes.length > 0) {
      console.error("ANON-CHECK VERIFY FALSE DRIFT — remaining changes:");
      for (const c of result.changes) console.error(`  - ${c.kind}:`, JSON.stringify(c));
    }
    // The anonymous DB check enforces the same constraint as the modeled enum;
    // no add-check / drop-check should be proposed.
    expect(result.changes).toEqual([]);
  });

  test("a genuine enum @values change on an anonymous-check table is NOT masked", async () => {
    // The model constrains status to (open, closed); the DB's anonymous check allows a
    // wider set (open, closed, archived). The expression-fallback must NOT match these —
    // real drift, reported as drop(anon) + add(modeled).
    const metadata = (await new MetaDataLoader().load([new InMemoryStringSource(METADATA_ENUM)])).root;
    const expected = buildExpectedSchema(metadata, { dialect: "sqlite" });
    await sql
      .raw("CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL CHECK (status IN ('open','closed','archived')))")
      .execute(k);
    const actual = await introspectSqlite(k);

    const result = await diff({ expected, actual, dialect: "sqlite" });
    const kinds = result.changes.map((c) => c.kind).sort();
    expect(kinds).toContain("add-check");
    expect(kinds).toContain("drop-check");
  });

  test("an UNMODELED anonymous check is dropped (not silently kept)", async () => {
    // Item.status is a plain string with no modeled constraint, but the DB carries an
    // anonymous CHECK. That check is drift the metadata doesn't own → drop-check fires.
    const metadata = (
      await new MetaDataLoader().load([
        new InMemoryStringSource(
          JSON.stringify({
            "metadata.root": {
              package: "test",
              children: [
                {
                  "object.entity": {
                    name: "Item",
                    children: [
                      { "source.rdb": { "@table": "items" } },
                      { "field.string": { name: "id", "@required": true } },
                      { "field.string": { name: "status", "@required": true } },
                      { "identity.primary": { "@fields": ["id"] } },
                    ],
                  },
                },
              ],
            },
          }),
        ),
      ])
    ).root;
    const expected = buildExpectedSchema(metadata, { dialect: "sqlite" });
    await sql
      .raw("CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL CHECK (status IN ('a','b')))")
      .execute(k);
    const actual = await introspectSqlite(k);

    const result = await diff({ expected, actual, dialect: "sqlite" });
    expect(result.changes.map((c) => c.kind)).toContain("drop-check");
  });
});
