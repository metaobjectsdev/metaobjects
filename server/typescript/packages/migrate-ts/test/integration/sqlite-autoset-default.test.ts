/**
 * Bug gate: `@autoSet` (onCreate/onUpdate) modeled its insert-time DEFAULT as the
 * dialect-agnostic `now()` — valid Postgres, a SYNTAX ERROR on SQLite/D1
 * (`Error: near "(": syntax error` at CREATE TABLE). Any entity with the standard
 * `createdAt @autoSet onCreate` pattern produced a migration that could not be
 * applied at all on sqlite/d1.
 *
 * Real-engine gate (per the layer-integration lesson in sqlite-default-semantics):
 *   load metadata → buildExpectedSchema(sqlite) → diff vs live introspection →
 *   emit → APPLY to real libsql → INSERT taking the default → assert a real
 *   timestamp was stored → introspect → re-diff EMPTY.
 *
 * The idempotence leg is the trap: mapping now() → CURRENT_TIMESTAMP only at
 * emit time (not in the expected snapshot) makes the three layers disagree —
 * expected `now()` vs introspected `CURRENT_TIMESTAMP` — and every subsequent
 * migrate reports change-column-default, which on SQLite recreate-and-copies
 * the whole table.
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
          name: "Event",
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "title", "@required": true } },
            { "field.timestamp": { name: "createdAt", "@autoSet": "onCreate", "@required": true } },
            { "field.timestamp": { name: "updatedAt", "@autoSet": "onUpdate", "@required": true } },
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
  tmpDir = mkdtempSync(join(tmpdir(), "migrate-ts-autoset-"));
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

async function migrateFromEmpty(): Promise<{ up: string; expected: ReturnType<typeof buildExpectedSchema> }> {
  const root = (await new MetaDataLoader().load([new InMemoryStringSource(META)])).root;
  const expected = buildExpectedSchema(root, { dialect: "sqlite" });
  const actual0 = await introspectSqlite(k);
  const initial = await diff(expected, actual0);
  const { up } = emit(initial.changes, {
    dialect: "sqlite",
    expectedSchema: expected,
    ...(actual0.meta !== undefined && { actualMeta: actual0.meta }),
  });
  await applyRaw(up); // the bug: DEFAULT now() → `near "(": syntax error` right here
  return { up, expected };
}

describe("SQLite @autoSet — real-engine apply + value semantics + idempotence", () => {
  test("the @autoSet migration APPLIES, and an insert taking the default stores a real timestamp", async () => {
    await migrateFromEmpty();

    await sql.raw(`INSERT INTO "events" ("id", "title") VALUES (1, 'launch')`).execute(k);
    const row = (await sql
      .raw(`SELECT "created_at" AS c, "updated_at" AS u FROM "events" WHERE "id" = 1`)
      .execute(k)).rows[0] as { c: unknown; u: unknown };

    // CURRENT_TIMESTAMP stores 'YYYY-MM-DD HH:MM:SS' text — a real datetime value,
    // not NULL and not the literal string "now()".
    for (const v of [row.c, row.u]) {
      expect(typeof v).toBe("string");
      expect(v as string).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    }
  });

  test("IDEMPOTENCE: re-diff against the live DB after apply is empty", async () => {
    const { expected } = await migrateFromEmpty();
    const followup = await diff(expected, await introspectSqlite(k));
    if (followup.changes.length > 0) {
      console.error("ROUND-TRIP FAILURE — a second `meta migrate` would emit:");
      for (const c of followup.changes) console.error("  -", JSON.stringify(c));
    }
    expect(followup.changes).toEqual([]);
  });
});
