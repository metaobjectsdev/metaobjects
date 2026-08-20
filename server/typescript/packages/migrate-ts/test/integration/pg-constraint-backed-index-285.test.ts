/**
 * #285 — a constraint-backed unique index must be DROPPED AS A CONSTRAINT.
 *
 * Postgres creates an index to enforce `UNIQUE` / `PRIMARY KEY` / `EXCLUDE`, and then
 * refuses to drop that index directly:
 *
 *   ERROR: cannot drop index work_item_message_id_unique because constraint
 *          work_item_message_id_unique on table work_item requires it
 *
 * `meta migrate` emitted a bare `DROP INDEX`, so the apply failed. Because apply is
 * transactional and all-or-nothing, this blocked EVERY other pending change in the same
 * invocation — an adopter could not create an unrelated new table while a cosmetic index
 * rename was outstanding.
 *
 * This is not a corner case: Drizzle's `unique()` emits a CONSTRAINT, not a bare unique
 * index, so any schema adopted from a Drizzle-managed database hits it on essentially
 * every unique index. Reported from a real adoption.
 *
 * The gate is a REAL engine, per this package's doctrine — emitted-SQL inspection is
 * exactly what missed the bug, since the SQL looked perfectly reasonable:
 *   1. Build the live shape the way Drizzle does (a UNIQUE *constraint*).
 *   2. Diff against metadata that names the key differently → drop-index + add-index.
 *   3. APPLY to the real engine. Pre-fix this throws; that is the regression.
 *   4. Re-introspect and re-diff → MUST be empty (convergence, not just "it ran").
 *   5. Prove uniqueness is still enforced afterwards — a dropped constraint that took
 *      its enforcement with it and never came back would also "converge".
 *
 * Skips gracefully when MIGRATE_TS_PG_URL is not set (ts-slow CI provides a PG sidecar).
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

// `identity.secondary` names the unique key `byMessageId`, while the live constraint is
// called `work_item_message_id_unique` — the rename that triggers drop+add.
const META = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "WorkItem",
          children: [
            { "source.rdb": { "@table": "work_item" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "messageId", "@column": "message_id", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            { "identity.secondary": { name: "byMessageId", "@fields": ["messageId"] } },
          ],
        },
      },
    ],
  },
});

async function applyRaw(k: Kysely<Record<string, unknown>>, sqlText: string): Promise<void> {
  for (const stmt of sqlText.split(";").map((s) => s.trim()).filter((s) => s.length > 0)) {
    await sql.raw(stmt).execute(k);
  }
}

describe("#285 — constraint-backed index drops as a constraint (PG)", () => {
  if (!PG_URL) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    return;
  }

  let kysely: Kysely<Record<string, unknown>>;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    kysely = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool }) });
    await sql.raw("DROP TABLE IF EXISTS work_item CASCADE").execute(kysely);
  });

  afterAll(async () => {
    await sql.raw("DROP TABLE IF EXISTS work_item CASCADE").execute(kysely);
    await pool.end();
  });

  test("introspection marks a UNIQUE-constraint-backed index, and a bare unique index not at all", async () => {
    await sql.raw("DROP TABLE IF EXISTS work_item CASCADE").execute(kysely);
    // Exactly the shape Drizzle produces: uniqueness as a CONSTRAINT…
    await sql
      .raw(
        `CREATE TABLE work_item (
           id serial PRIMARY KEY,
           message_id text NOT NULL,
           other text,
           CONSTRAINT work_item_message_id_unique UNIQUE (message_id)
         )`,
      )
      .execute(kysely);
    // …alongside a plain CREATE INDEX, to prove the marker discriminates.
    await sql.raw(`CREATE UNIQUE INDEX work_item_other_idx ON work_item (other)`).execute(kysely);

    const actual = await introspectPostgres(kysely);
    const t = actual.tables.find((x) => x.name === "work_item");
    expect(t).toBeDefined();

    const backed = t?.indexes?.find((i) => i.name === "work_item_message_id_unique");
    expect(backed?.constraint).toBe("unique");

    const bare = t?.indexes?.find((i) => i.name === "work_item_other_idx");
    expect(bare).toBeDefined();
    expect(bare?.constraint).toBeUndefined();
  });

  test("REGRESSION: the rename applies against a real engine, converges, and keeps uniqueness", async () => {
    await sql.raw("DROP TABLE IF EXISTS work_item CASCADE").execute(kysely);
    await sql
      .raw(
        `CREATE TABLE work_item (
           id serial PRIMARY KEY,
           message_id text NOT NULL,
           CONSTRAINT work_item_message_id_unique UNIQUE (message_id)
         )`,
      )
      .execute(kysely);

    const loaded = await new MetaDataLoader().load([new InMemoryStringSource(META)]);
    expect(loaded.errors).toEqual([]);
    const expectedSchema = buildExpectedSchema(loaded.root, { dialect: "postgres" });

    const actual = await introspectPostgres(kysely);
    const d = await diff({ expected: expectedSchema, actual, dialect: "postgres", allow: { dropIndex: true } });

    // The rename really does present as drop+add — the precondition for the bug.
    expect(d.changes.some((c) => c.kind === "drop-index")).toBe(true);

    const sqlText = emit(d.changes, { dialect: "postgres" }).up;
    // The whole point: a DROP INDEX here is what Postgres refuses.
    //
    // `(IF EXISTS )?` is load-bearing on the NEGATIVE assertion. #313 put `IF EXISTS`
    // on every forward drop, so without the optional group this stops matching because
    // the SPELLING changed — passing for a reason unrelated to #285, and continuing to
    // pass if #285 fully regressed. Verified by reverting the drop-index arm and
    // watching this line go red.
    expect(sqlText).not.toMatch(/DROP INDEX (IF EXISTS )?"?work_item_message_id_unique/);
    expect(sqlText).toMatch(/ALTER TABLE .*DROP CONSTRAINT IF EXISTS "work_item_message_id_unique"/);

    // Pre-fix this throws: cannot drop index … because constraint … requires it.
    await applyRaw(kysely, sqlText);

    // CONVERGENCE — re-introspect and re-diff must be EMPTY, not merely "it applied".
    const after = await introspectPostgres(kysely);
    const reDiff = await diff({ expected: expectedSchema, actual: after, dialect: "postgres" });
    expect(reDiff.changes.map((c) => c.kind)).toEqual([]);

    // VALUE SEMANTICS — uniqueness must still be enforced. A migration that simply
    // dropped the constraint and never re-added an equivalent would also "converge".
    await sql.raw(`INSERT INTO work_item (message_id) VALUES ('m-1')`).execute(kysely);
    await expect(
      sql.raw(`INSERT INTO work_item (message_id) VALUES ('m-1')`).execute(kysely),
    ).rejects.toThrow(/unique|duplicate key/i);
  });
});
