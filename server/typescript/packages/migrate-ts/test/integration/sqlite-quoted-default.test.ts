/**
 * Bug gate: a literal @default containing a single-quote (e.g. "don't") was
 * escaped to `''` at emit time (`DEFAULT 'don''t'`) but introspection only
 * stripped the OUTER quotes, reading back `don''t`. The strict string compare in
 * columnDefaultsEqual then reported change-column-default on EVERY run — which on
 * SQLite recreate-and-copies the whole table forever (and on PG issues a bogus
 * ALTER every run).
 *
 * Real-engine gate: full pipeline against libsql, then (1) INSERT a row taking
 * the default and assert the engine stored the UN-escaped value, (2) re-diff
 * must be EMPTY.
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
          name: "Quip",
          children: [
            { "field.long": { name: "id" } },
            // The quote-bearing literal default under test.
            { "field.string": { name: "greeting", "@default": "don't panic", "@required": true } },
            // Multiple embedded quotes, to catch a first-occurrence-only unescape.
            { "field.string": { name: "shrug", "@default": "it's o'clock", "@required": true } },
            { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

let tmpDir: string;
let k: Kysely<Record<string, unknown>>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "migrate-ts-quoted-default-"));
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

async function migrateFromEmpty(): Promise<{ expected: ReturnType<typeof buildExpectedSchema> }> {
  const root = (await new MetaDataLoader().load([new InMemoryStringSource(META)])).root;
  const expected = buildExpectedSchema(root, { dialect: "sqlite" });
  const actual0 = await introspectSqlite(k);
  const initial = await diff(expected, actual0);
  const { up } = emit(initial.changes, {
    dialect: "sqlite",
    expectedSchema: expected,
    ...(actual0.meta !== undefined && { actualMeta: actual0.meta }),
  });
  await applyRaw(up);
  return { expected };
}

describe("SQLite quote-bearing literal defaults — real-engine round-trip", () => {
  test("the engine stores the UN-escaped value when a row takes the default", async () => {
    await migrateFromEmpty();
    await sql.raw(`INSERT INTO "quips" ("id") VALUES (1)`).execute(k);
    const row = (await sql
      .raw(`SELECT "greeting" AS g, "shrug" AS s FROM "quips" WHERE "id" = 1`)
      .execute(k)).rows[0] as { g: unknown; s: unknown };
    expect(row.g).toBe("don't panic");
    expect(row.s).toBe("it's o'clock");
  });

  test("IDEMPOTENCE: re-diff after apply is empty (no perpetual change-column-default)", async () => {
    const { expected } = await migrateFromEmpty();
    const followup = await diff(expected, await introspectSqlite(k));
    if (followup.changes.length > 0) {
      console.error("ROUND-TRIP FAILURE — a second `meta migrate` would emit:");
      for (const c of followup.changes) console.error("  -", JSON.stringify(c));
    }
    expect(followup.changes).toEqual([]);
  });
});
