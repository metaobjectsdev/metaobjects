/**
 * SQLite recreate-and-copy round-trip integration test (load-bearing).
 *
 * Per spec §9 #7. Two scenarios: change-column-default preserving 3 rows
 * across a full recreate, rename-column inside recreate mapping data
 * correctly (old name in SELECT → new name in INSERT into __new_<table>).
 * Round-trip invariant holds in both: re-diff after apply yields [].
 * Uses libsql tmp file (BEGIN/COMMIT in recreate would break :memory:
 * connection state).
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { MetaDataLoader, InMemorySource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspectSqlite } from "../../src/introspect/sqlite.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";

let tmpDir: string;
let k: Kysely<Record<string, unknown>>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "migrate-ts-recreate-"));
  const url = `file:${join(tmpDir, "test.db")}`;
  k = new Kysely({ dialect: new LibsqlDialect({ url }) });
});

afterEach(async () => {
  await k.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Execute a multi-statement SQL string against SQLite via libsql.
 *
 * libsql's execute() is single-statement-only — multi-statement strings
 * silently stop after the first statement. Always split on ";" and execute
 * each statement individually. This works for both plain DDL and
 * recreate-and-copy blocks (PRAGMA / BEGIN TRANSACTION / DDL / COMMIT).
 */
async function applyRaw(kysely: Kysely<Record<string, unknown>>, sqlText: string): Promise<void> {
  for (const stmt of sqlText.trim().split(";").map((s) => s.trim()).filter((s) => s.length > 0)) {
    await sql.raw(stmt).execute(kysely);
  }
}

describe("SQLite recreate-and-copy — data preservation", () => {
  test("change-column-default preserves rows", async () => {
    // Initial schema: Item with id, name (required), tag (with default).
    const json1 = {
      "metadata.root": {
        children: [{
          "object.entity": {
            name: "Item",
            children: [
              { "field.long": { name: "id" } },
              { "field.string": { name: "name", "@required": true } },
              { "field.string": { name: "tag", "@default": "untagged" } },
              { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            ],
          },
        }],
      },
    };
    const metadata1 = (await new MetaDataLoader().load([new InMemorySource(JSON.stringify(json1))])).root;
    const expected1 = buildExpectedSchema(metadata1);
    {
      const initial = await diff(expected1, await introspectSqlite(k));
      expect(initial.blocked).toEqual([]);
      const { up } = emit(initial.changes, { dialect: "sqlite", expectedSchema: expected1 });
      await applyRaw(k, up);
    }

    // Insert 3 rows with explicit tag values (not the default).
    await sql`INSERT INTO items (name, tag) VALUES ('a', 'red'), ('b', 'blue'), ('c', 'green')`.execute(k as never);

    // Mutate metadata: change tag default to 'default-tag'.
    const json2 = JSON.parse(JSON.stringify(json1));
    const tagField = json2["metadata.root"].children[0]["object.entity"].children.find(
      (ch: { "field.string"?: { name: string } }) => ch["field.string"]?.name === "tag",
    );
    tagField["field.string"]["@default"] = "default-tag";
    const metadata2 = (await new MetaDataLoader().load([new InMemorySource(JSON.stringify(json2))])).root;
    const expected2 = buildExpectedSchema(metadata2);

    const second = await diff(expected2, await introspectSqlite(k));
    expect(second.changes.find((c) => c.kind === "change-column-default")).toBeDefined();

    const { up: up2 } = emit(second.changes, { dialect: "sqlite", expectedSchema: expected2 });
    // Change-column-default triggers recreate-and-copy.
    expect(up2).toContain("BEGIN TRANSACTION");
    expect(up2).toContain('"__new_items"');

    await applyRaw(k, up2);

    // Verify all 3 rows are preserved with their original tag values.
    const rows = await sql<{ id: number; name: string; tag: string }>`
      SELECT id, name, tag FROM items ORDER BY id
    `.execute(k as never);
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.map((r) => r.name)).toEqual(["a", "b", "c"]);
    expect(rows.rows.map((r) => r.tag)).toEqual(["red", "blue", "green"]);

    // Re-diff must yield no changes.
    const followup = await diff(expected2, await introspectSqlite(k));
    if (followup.changes.length > 0) {
      console.error("ROUND-TRIP FAILURE (change-column-default) — remaining changes:");
      for (const c of followup.changes) console.error(`  - ${c.kind}:`, JSON.stringify(c, null, 2));
    }
    expect(followup.changes).toEqual([]);
  });

  test("rename-column inside recreate maps data correctly", async () => {
    // Initial schema: Person with id, firstName (required), and a tag field with a default.
    // The tag field's default will be changed to trigger recreate-and-copy while also
    // renaming firstName → first_name_v2 — verifying the rename SELECT mapping works.
    const json1 = {
      "metadata.root": {
        children: [{
          "object.entity": {
            name: "Person",
            children: [
              { "field.long": { name: "id" } },
              { "field.string": { name: "firstName", "@required": true } },
              { "field.string": { name: "tag", "@default": "v1" } },
              { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            ],
          },
        }],
      },
    };
    const metadata1 = (await new MetaDataLoader().load([new InMemorySource(JSON.stringify(json1))])).root;
    const expected1 = buildExpectedSchema(metadata1);
    {
      const initial = await diff(expected1, await introspectSqlite(k));
      expect(initial.blocked).toEqual([]);
      const { up } = emit(initial.changes, { dialect: "sqlite", expectedSchema: expected1 });
      await applyRaw(k, up);
    }

    // Insert 2 rows using the original column name (first_name — snake_case of firstName).
    // Table name is "persons" (Person → person → persons).
    await sql`INSERT INTO persons (first_name, tag) VALUES ('alice', 'red'), ('bob', 'blue')`.execute(k as never);

    // Rename firstName → first_name_v2 (close to "first_name" for the rename heuristic).
    // Also change tag's default to force recreate-and-copy — so the rename goes through
    // the recreate path and we can verify SELECT old_name → INSERT new_name mapping.
    const json2 = JSON.parse(JSON.stringify(json1));
    const f = json2["metadata.root"].children[0]["object.entity"].children.find(
      (ch: { "field.string"?: { name: string } }) => ch["field.string"]?.name === "firstName",
    );
    f["field.string"].name = "first_name_v2";         // close enough for the rename heuristic
    const tagField = json2["metadata.root"].children[0]["object.entity"].children.find(
      (ch: { "field.string"?: { name: string } }) => ch["field.string"]?.name === "tag",
    );
    tagField["field.string"]["@default"] = "v2";      // change tag default to trigger recreate-and-copy
    const metadata2 = (await new MetaDataLoader().load([new InMemorySource(JSON.stringify(json2))])).root;
    const expected2 = buildExpectedSchema(metadata2);

    const second = await diff({
      expected: expected2,
      actual: await introspectSqlite(k),
      onAmbiguous: async () => "rename",
    });
    expect(second.changes.find((c) => c.kind === "rename-column")).toBeDefined();
    expect(second.changes.find((c) => c.kind === "change-column-default")).toBeDefined();

    const { up: up2 } = emit(second.changes, { dialect: "sqlite", expectedSchema: expected2 });
    expect(up2).toContain("BEGIN TRANSACTION");   // confirms recreate-and-copy path
    await applyRaw(k, up2);

    // Verify data is in the new column name with original values intact.
    const rows = await sql<{ first_name_v2: string; tag: string }>`
      SELECT first_name_v2, tag FROM persons ORDER BY id
    `.execute(k as never);
    expect(rows.rows.map((r) => r.first_name_v2)).toEqual(["alice", "bob"]);
    expect(rows.rows.map((r) => r.tag)).toEqual(["red", "blue"]);  // original values preserved

    // Re-diff must yield no changes.
    const followup = await diff(expected2, await introspectSqlite(k));
    if (followup.changes.length > 0) {
      console.error("ROUND-TRIP FAILURE (rename-column inside recreate) — remaining changes:");
      for (const c of followup.changes) console.error(`  - ${c.kind}:`, JSON.stringify(c, null, 2));
    }
    expect(followup.changes).toEqual([]);
  });
});
