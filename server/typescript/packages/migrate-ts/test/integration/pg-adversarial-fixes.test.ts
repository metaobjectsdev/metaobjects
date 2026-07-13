/**
 * Real-Postgres gates for the adversarial-review fix batch — the PG legs of:
 *
 *   - @isArray scalar columns (int[]/numeric[]/bool[]/timestamptz[]/enum-text[]):
 *     the migrated column must ACCEPT an array INSERT (the reported failure was
 *     `column "x" is of type integer but expression is of type integer[]`) and
 *     the re-diff must be EMPTY (information_schema drops element qualifiers, so
 *     a qualified expected element would churn forever).
 *
 *   - quote-bearing literal defaults (`@default "don't"`): PG stores
 *     `'don''t'::text`; introspection must un-double the quotes or the diff
 *     issues a bogus SET DEFAULT on every run.
 *
 *   - extension-owned views: CREATE EXTENSION pg_stat_statements installs a view
 *     in `public`; introspection must NOT report it (pg_depend deptype='e'), or
 *     the next migrate proposes DROP VIEW on an extension's object.
 *
 * Gated on MIGRATE_TS_PG_URL (same convention as every pg integration test in
 * this package); skips cleanly when unset.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspectPostgres } from "../../src/introspect/postgres.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";

const PG_URL = process.env["MIGRATE_TS_PG_URL"];
const realDescribe = PG_URL ? describe : describe.skip;

const META = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "Reading",
          children: [
            { "field.long": { name: "id" } },
            // Bug 6 — the scalar @isArray fan-out beyond string/uuid.
            { "field.int": { name: "counts", isArray: true } },
            { "field.decimal": { name: "amounts", isArray: true, "@precision": 10, "@scale": 2 } },
            { "field.boolean": { name: "flags", isArray: true } },
            { "field.timestamp": { name: "stamps", isArray: true } },
            { "field.enum": { name: "labels", isArray: true, "@values": ["A", "B"] } },
            // Bug 3 — quote-bearing literal default.
            { "field.string": { name: "greeting", "@default": "don't panic", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

let k: Kysely<Record<string, unknown>>;
let pool: Pool;

if (PG_URL) {
  beforeAll(() => {
    pool = new Pool({ connectionString: PG_URL });
    k = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool }) });
  });
  afterAll(async () => {
    await cleanup();
    await k.destroy();
  });
}

async function cleanup(): Promise<void> {
  await sql.raw(`DROP TABLE IF EXISTS "readings" CASCADE`).execute(k);
  await sql.raw(`DROP VIEW IF EXISTS "user_owned_probe_view"`).execute(k);
  await sql.raw(`DROP EXTENSION IF EXISTS pg_stat_statements`).execute(k);
}

async function applyRaw(sqlText: string): Promise<void> {
  for (const stmt of sqlText.split(";").map((s) => s.trim()).filter(Boolean)) {
    await sql.raw(stmt).execute(k);
  }
}

async function migrateFromEmpty(): Promise<ReturnType<typeof buildExpectedSchema>> {
  const root = (await new MetaDataLoader().load([new InMemoryStringSource(META)])).root;
  const expected = buildExpectedSchema(root, { dialect: "postgres" });
  const actual = await introspectPostgres(k);
  const result = await diff({ expected, actual, dialect: "postgres" });
  expect(result.blocked).toEqual([]);
  const { up } = emit(result.changes, { dialect: "postgres", expectedSchema: expected });
  await applyRaw(up);
  return expected;
}

realDescribe("PG adversarial fixes — real-engine value semantics + idempotence", () => {
  test("@isArray scalars: array INSERT works, engine stores real arrays, re-diff empty", async () => {
    await cleanup();
    const expected = await migrateFromEmpty();

    // The reported first-insert failure: an ARRAY expression into the column.
    await sql.raw(
      `INSERT INTO "readings" ("id", "counts", "amounts", "flags", "stamps", "labels", "greeting")
       VALUES (1, ARRAY[1,2,3], ARRAY[9.50, 12.25], ARRAY[true,false],
               ARRAY['2026-01-01T00:00:00Z'::timestamptz], ARRAY['A','B'], 'hi')`,
    ).execute(k);

    const row = (await sql.raw(
      `SELECT pg_typeof("counts")::text AS t_counts,
              pg_typeof("amounts")::text AS t_amounts,
              pg_typeof("flags")::text AS t_flags,
              pg_typeof("stamps")::text AS t_stamps,
              pg_typeof("labels")::text AS t_labels,
              "counts"[2] AS second_count
       FROM "readings" WHERE "id" = 1`,
    ).execute(k)).rows[0] as Record<string, unknown>;
    expect(row["t_counts"]).toBe("integer[]");
    expect(row["t_amounts"]).toBe("numeric[]");
    expect(row["t_flags"]).toBe("boolean[]");
    expect(row["t_stamps"]).toBe("timestamp with time zone[]");
    expect(row["t_labels"]).toBe("text[]");
    expect(Number(row["second_count"])).toBe(2);

    // Idempotence — information_schema returns NO element qualifiers for
    // arrays, so this is where a qualified expected element would churn.
    const followup = await diff({ expected, actual: await introspectPostgres(k), dialect: "postgres" });
    if (followup.changes.length > 0) {
      console.error("ROUND-TRIP FAILURE — a second `meta migrate` would emit:");
      for (const c of followup.changes) console.error("  -", JSON.stringify(c));
    }
    expect(followup.changes).toEqual([]);
  });

  test("quote-bearing @default: engine stores the un-escaped value; no bogus SET DEFAULT", async () => {
    await cleanup();
    const expected = await migrateFromEmpty();

    await sql.raw(
      `INSERT INTO "readings" ("id", "counts", "amounts", "flags", "stamps", "labels")
       VALUES (2, ARRAY[]::integer[], ARRAY[]::numeric[], ARRAY[]::boolean[],
               ARRAY[]::timestamptz[], ARRAY[]::text[])`,
    ).execute(k);
    const row = (await sql.raw(`SELECT "greeting" AS g FROM "readings" WHERE "id" = 2`).execute(k))
      .rows[0] as { g: unknown };
    expect(row.g).toBe("don't panic");

    const followup = await diff({ expected, actual: await introspectPostgres(k), dialect: "postgres" });
    expect(followup.changes).toEqual([]);
  });

  test("extension-owned views are invisible to introspection; user views are not", async () => {
    await cleanup();
    // pg_stat_statements ships in the official postgres image (contrib). The
    // extension CREATEs fine without shared_preload_libraries — only QUERYING
    // its view needs the preload, and introspection never queries it.
    await sql.raw(`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`).execute(k);
    await sql.raw(`CREATE VIEW "user_owned_probe_view" AS SELECT 1 AS one`).execute(k);

    const snapshot = await introspectPostgres(k);
    const names = snapshot.views.map((v) => v.name);
    expect(names).toContain("user_owned_probe_view");
    expect(names).not.toContain("pg_stat_statements");
    expect(names).not.toContain("pg_stat_statements_info");

    // The consequence that mattered: an empty model must NOT propose dropping
    // the extension's view. (The user view drop IS proposed — and now gated.)
    const result = await diff({
      expected: { tables: [], views: [] }, actual: snapshot, dialect: "postgres",
    });
    const dropViews = result.changes.filter((c) => c.kind === "drop-view");
    expect(dropViews.map((c) => (c as { view: string }).view)).toEqual(["user_owned_probe_view"]);
    for (const d of dropViews) expect(d.status.state).toBe("blocked"); // gated now
  });
});
