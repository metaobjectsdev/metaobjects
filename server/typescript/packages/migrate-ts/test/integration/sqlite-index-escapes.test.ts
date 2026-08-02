/**
 * Bug gate: the SQLite emitter silently dropped every index physical escape —
 * rendering ONLY `unique` + `columns`:
 *
 *   - `@expr` (expression index)      → emitted `CREATE INDEX "x" ON "t" ();`
 *                                       → INVALID SQL, the apply failed outright;
 *   - `@where` (partial index)        → a partial UNIQUE became a FULL unique —
 *                                       silently rejecting inserts the model says
 *                                       are valid (unique-among-active with soft
 *                                       deletes) — and introspection SKIPPED
 *                                       partial indexes, so the diff churned
 *                                       drop/add forever;
 *   - `@orders: desc`                 → dropped → same churn.
 *   - `@using`                        → SQLite has exactly one access method
 *                                       (b-tree, no USING clause), so it is
 *                                       IGNORED for sqlite: the expected snapshot
 *                                       strips it (Pass 3) and the emitter never
 *                                       renders it, keeping the diff convergent.
 *
 * SQLite natively supports expression indexes, partial indexes (WHERE) and
 * `col DESC` — this gate proves emit renders them, the engine ENFORCES them
 * (value semantics below), introspection reads them back, and the re-diff is
 * EMPTY.
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
          name: "Account",
          children: [
            { "source.rdb": {} },
            { "field.long": { name: "id" } },
            { "field.string": { name: "email", "@required": true } },
            { "field.string": { name: "tags" } },
            { "field.timestamp": { name: "deletedAt" } },
            { "field.timestamp": { name: "createdAt", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            // Partial UNIQUE: email unique AMONG ACTIVE ROWS only (soft deletes).
            {
              "identity.secondary": {
                name: "accounts_active_email_uq",
                "@fields": ["email"],
                "@where": "deleted_at IS NULL",
              },
            },
            // Expression index (sqlite-valid expression).
            {
              "index.lookup": {
                name: "accounts_email_lower_idx",
                "@fields": ["email"],
                "@expr": "lower(email)",
              },
            },
            // Ordered composite lookup with a DESC key.
            {
              "index.lookup": {
                name: "accounts_recent_idx",
                "@fields": ["email", "createdAt"],
                "@orders": ["asc", "desc"],
              },
            },
            // @using has no sqlite equivalent — must be ignored WITHOUT churn.
            {
              "index.lookup": {
                name: "accounts_tags_idx",
                "@fields": ["tags"],
                "@using": "gin",
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
  tmpDir = mkdtempSync(join(tmpdir(), "migrate-ts-index-escapes-"));
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

async function migrateFromEmpty(): Promise<ReturnType<typeof buildExpectedSchema>> {
  const root = (await new MetaDataLoader().load([new InMemoryStringSource(META)])).root;
  const expected = buildExpectedSchema(root, { dialect: "sqlite" });
  const actual0 = await introspectSqlite(k);
  const initial = await diff({ expected, actual: actual0, dialect: "sqlite" });
  const { up } = emit(initial.changes, {
    dialect: "sqlite",
    expectedSchema: expected,
    ...(actual0.meta !== undefined && { actualMeta: actual0.meta }),
  });
  await applyRaw(up); // the @expr bug: `CREATE INDEX … ();` → syntax error here
  return expected;
}

describe("SQLite index physical escapes — real-engine apply + semantics + idempotence", () => {
  test("partial UNIQUE actually behaves partially (soft-delete duplicate allowed; active duplicate rejected)", async () => {
    await migrateFromEmpty();
    await sql.raw(
      `INSERT INTO "accounts" ("id", "email", "created_at", "deleted_at")
       VALUES (1, 'a@x.io', '2026-01-01 00:00:00', '2026-02-01 00:00:00')`,
    ).execute(k);
    // Same email again, ACTIVE — the model says this is valid (the old row is
    // soft-deleted). A full UNIQUE (the bug) rejects it.
    await sql.raw(
      `INSERT INTO "accounts" ("id", "email", "created_at") VALUES (2, 'a@x.io', '2026-03-01 00:00:00')`,
    ).execute(k);
    // A second ACTIVE row with the same email violates the partial unique.
    await expect(
      sql.raw(
        `INSERT INTO "accounts" ("id", "email", "created_at") VALUES (3, 'a@x.io', '2026-04-01 00:00:00')`,
      ).execute(k),
    ).rejects.toThrow(/UNIQUE/i);
  });

  test("IDEMPOTENCE: expr / where / orders / using all read back — re-diff is empty", async () => {
    const expected = await migrateFromEmpty();
    const followup = await diff({ expected, actual: await introspectSqlite(k), dialect: "sqlite" });
    if (followup.changes.length > 0) {
      console.error("ROUND-TRIP FAILURE — a second `meta migrate` would emit:");
      for (const c of followup.changes) console.error("  -", JSON.stringify(c));
    }
    expect(followup.changes).toEqual([]);
  });

  test("the expression index exists on the engine with its expression key", async () => {
    await migrateFromEmpty();
    const row = (await sql
      .raw(`SELECT sql FROM sqlite_master WHERE type='index' AND name='accounts_email_lower_idx'`)
      .execute(k)).rows[0] as { sql: string } | undefined;
    expect(row?.sql ?? "").toContain("lower(email)");
  });
});
