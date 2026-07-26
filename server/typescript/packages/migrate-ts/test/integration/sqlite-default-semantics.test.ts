/**
 * The gate this package most needed and did not have: run the WHOLE pipeline against a
 * REAL SQLite engine and assert BOTH properties that matter.
 *
 *   1. IDEMPOTENCE — emit → apply → introspect → re-diff must be EMPTY. Catches any
 *      asymmetry between what emit writes, what introspect reads back, and what
 *      expected-schema models. (That asymmetry is what made a uuid-PK's synthesized
 *      DEFAULT rebuild every table on every migrate.)
 *
 *   2. VALUE SEMANTICS — actually INSERT a row that takes the column defaults and ask
 *      SQLite what it stored. Idempotence alone is BLIND to *consistently* wrong
 *      behavior: emit and introspect can agree on `DEFAULT 'false'` and converge
 *      happily, while SQLite stores the TEXT string "false" in a numeric column and
 *      `WHERE flag = 0` silently matches nothing.
 *
 * Every prior test in this package asserted strings the emitter produced, or diffed
 * hand-built descriptors against each other — so both bugs were invisible by construction.
 *
 * NOTE the interaction that makes this subtle: for sqlite/d1, `buildExpectedSchema`
 * Pass 3 normalizes a boolean column's *type* to integer, so the emitter never sees
 * `kind: "boolean"`. The default *value* must be normalized with it, or the two layers
 * disagree — emit `0`, expected `"false"`, introspect `"0"` — and `columnDefaultsEqual`
 * (a strict string compare) reports `change-column-default` forever, which on SQLite
 * means a destructive recreate-and-copy of the whole table on every run.
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
          name: "Photo",
          children: [
            { "field.long": { name: "id" } },
            { "field.boolean": { name: "isPrimary", "@default": false, "@required": true } },
            { "field.boolean": { name: "isPublished", "@default": true, "@required": true } },
            { "field.int": { name: "sortOrder", "@default": 0, "@required": true } },
            { "field.string": { name: "label", "@default": "none", "@required": true } },
            // #235 — an EMPTY-string default must round-trip (was dropped as falsy → drift).
            { "field.string": { name: "caption", "@default": "", "@required": true } },
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
  tmpDir = mkdtempSync(join(tmpdir(), "migrate-ts-default-semantics-"));
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

/** Full pipeline: build → diff-from-empty → emit → apply. Returns the emitted up-SQL. */
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
  await applyRaw(up);
  return { up, expected };
}

describe("SQLite defaults — real-engine value semantics + idempotence", () => {
  test("a boolean @default is stored as an INTEGER, and `= 0` / `= 1` actually match", async () => {
    await migrateFromEmpty();
    // Take the column defaults — the write path a non-Drizzle client (or raw SQL) uses.
    await sql.raw(`INSERT INTO "photos" ("id") VALUES (1)`).execute(k);

    const row = (await sql
      .raw(
        `SELECT typeof("is_primary") AS t_primary, typeof("is_published") AS t_published,
                typeof("sort_order") AS t_sort, "is_primary" AS p, "is_published" AS pub
         FROM "photos"`,
      )
      .execute(k)).rows[0] as Record<string, unknown>;

    // The bug: `DEFAULT 'false'` on a numeric-affinity column stores the TEXT "false".
    expect(row["t_primary"]).toBe("integer");
    expect(row["t_published"]).toBe("integer");
    expect(row["t_sort"]).toBe("integer");
    expect(row["p"]).toBe(0);
    expect(row["pub"]).toBe(1);

    // …and the consequence that actually bites in production: the filter misses the row.
    const hits = (await sql
      .raw(`SELECT COUNT(*) AS c FROM "photos" WHERE "is_primary" = 0`)
      .execute(k)).rows[0] as { c: number };
    expect(Number(hits.c)).toBe(1);
  });

  test("IDEMPOTENCE: after applying, a re-diff against the live DB is empty", async () => {
    const { expected } = await migrateFromEmpty();
    const actual = await introspectSqlite(k);
    const followup = await diff(expected, actual);
    if (followup.changes.length > 0) {
      console.error("ROUND-TRIP FAILURE — a second `meta migrate` would emit:");
      for (const c of followup.changes) console.error("  -", JSON.stringify(c));
    }
    // A non-empty re-diff here means every subsequent migrate re-runs this change —
    // and on SQLite a change-column-default recreate-and-copies the WHOLE table.
    expect(followup.changes).toEqual([]);
  });

  test("a text @default still round-trips and is stored as text", async () => {
    await migrateFromEmpty();
    await sql.raw(`INSERT INTO "photos" ("id") VALUES (2)`).execute(k);
    const row = (await sql
      .raw(`SELECT typeof("label") AS t, "label" AS l FROM "photos" WHERE "id" = 2`)
      .execute(k)).rows[0] as Record<string, unknown>;
    expect(row["t"]).toBe("text");
    expect(row["l"]).toBe("none");
  });

  test("#235 an EMPTY-string @default emits DEFAULT '' and stores the empty string (not NULL)", async () => {
    const { up } = await migrateFromEmpty();
    // The emitter must render the empty-string literal, not drop it.
    expect(up).toMatch(/"caption"\s+text\s+not null\s+default\s+''/i);
    await sql.raw(`INSERT INTO "photos" ("id") VALUES (3)`).execute(k);
    const row = (await sql
      .raw(`SELECT typeof("caption") AS t, "caption" AS c FROM "photos" WHERE "id" = 3`)
      .execute(k)).rows[0] as Record<string, unknown>;
    expect(row["t"]).toBe("text");
    expect(row["c"]).toBe(""); // the empty string, applied from DEFAULT '' — NOT NULL
  });
});
