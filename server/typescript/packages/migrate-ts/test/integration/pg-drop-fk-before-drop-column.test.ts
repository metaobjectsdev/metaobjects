/**
 * Real-Postgres gate for #255 — "a table whose column is referenced by
 * another table's FK, where the metadata drops both the FK and the column."
 *
 * Root cause: the emitter's STAGE_ORDER put `drop-column` (stage 2) before
 * `drop-fk`/`drop-check`/`drop-index` (originally stage 5/5/4), so the
 * emitted UP SQL issued `ALTER TABLE "programs" DROP COLUMN "code"` while
 * `weeks_program_code_fk` — another table's FK constraint referencing that
 * column — AND `uniqueCode` — the UNIQUE index backing that same column
 * (Postgres requires an FK target to be unique) — both still existed.
 * Postgres refuses: "cannot drop column code of table programs because other
 * objects depend on it." The fix hoists ALL drops that can have an external
 * dependent — `drop-fk` / `drop-check` / `drop-index` — ahead of column
 * mutation, while their ADD counterparts (`add-fk` / `add-check` /
 * `add-index`) stay at their later, post-column stage. Within that group,
 * `drop-fk`/`drop-check` ALSO run before `drop-index`: the FK constraint
 * itself depends on the unique index backing its target column, so dropping
 * the index first fails one level removed ("cannot drop index … because
 * other objects depend on it" / "constraint … depends on index …"). This
 * test proves the reordered SQL actually applies against a real engine, for
 * the COMBINED scenario (a column that is BOTH FK-referenced AND
 * index-backed, with the metadata dropping the FK, the index, and the column
 * all in one change-set) — a unit assertion on statement order alone is not
 * sufficient evidence; see emit-postgres.test.ts / emit-sqlite.test.ts for
 * that half.
 *
 * Gated on MIGRATE_TS_PG_URL, like every other pg integration test in this
 * package. Skips cleanly when unset.
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

// V1: Program (id PK, code UNIQUE) + Week (id PK, programCode FK -> Program.code).
const V1 = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "Program",
          children: [
            { "source.rdb": {} },
            { "field.long": { name: "id" } },
            { "field.string": { name: "code", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            { "identity.secondary": { name: "uniqueCode", "@fields": ["code"] } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Week",
          children: [
            { "source.rdb": {} },
            { "field.long": { name: "id" } },
            { "field.string": { name: "programCode", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            { "identity.reference": { name: "ref_program", "@fields": ["programCode"], "@references": "Program.code" } },
          ],
        },
      },
    ],
  },
});

// V2: Program drops `code` (+ its identity.secondary index); Week drops the
// FK (identity.reference) but keeps its own `programCode` column (now a
// plain, un-constrained column) — the exact shape that produces a drop-fk +
// drop-index + drop-column TRIPLE where the dropped column is both the FK's
// REFERENCED side and the index's target.
const V2 = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "Program",
          children: [
            { "source.rdb": {} },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Week",
          children: [
            { "source.rdb": {} },
            { "field.long": { name: "id" } },
            { "field.string": { name: "programCode", "@required": true } },
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
  await sql.raw(`DROP TABLE IF EXISTS "weeks" CASCADE`).execute(k);
  await sql.raw(`DROP TABLE IF EXISTS "programs" CASCADE`).execute(k);
}

async function applyRaw(sqlText: string): Promise<void> {
  for (const stmt of sqlText.split(";").map((s) => s.trim()).filter(Boolean)) {
    await sql.raw(stmt).execute(k);
  }
}

async function loadRoot(json: string) {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}

realDescribe("PG #255 — drop-fk/drop-check/drop-index before drop-column applies cleanly", () => {
  test("dropping an FK's referenced+indexed column, the FK, and the index together: emitted SQL applies, re-diff empty", async () => {
    await cleanup();

    // Establish v1 (Program + Week, FK referencing Program.code) against a real, empty DB.
    const v1Root = await loadRoot(V1);
    const expected1 = buildExpectedSchema(v1Root, { dialect: "postgres" });
    const actual0 = await introspectPostgres(k);
    const initial = await diff({ expected: expected1, actual: actual0, dialect: "postgres" });
    expect(initial.blocked).toEqual([]);
    const emit1 = emit(initial.changes, { dialect: "postgres", expectedSchema: expected1 });
    await applyRaw(emit1.up);

    // Sanity: the FK is live and both columns exist.
    await sql.raw(`INSERT INTO "programs" ("id", "code") VALUES (1, 'P1')`).execute(k);
    await sql.raw(`INSERT INTO "weeks" ("id", "program_code") VALUES (1, 'P1')`).execute(k);

    // Evolve to v2: drop Program.code (the FK's referenced + indexed
    // column), the FK, AND the backing unique index, all in one change-set —
    // the COMBINED scenario. Pre-fix, this fails on either the FK dependency
    // or the auto-cascaded index (whichever the (buggy) order hits first);
    // post-fix, both drops run before the column drop and it all applies.
    const v2Root = await loadRoot(V2);
    const expected2 = buildExpectedSchema(v2Root, { dialect: "postgres" });
    const actual1 = await introspectPostgres(k);
    const evolve = await diff({
      expected: expected2, actual: actual1, dialect: "postgres",
      allow: { dropColumn: true, dropFk: true, dropIndex: true },
    });
    expect(evolve.blocked).toEqual([]);
    const kinds = evolve.changes.map((c) => c.kind).sort();
    expect(kinds).toEqual(["drop-column", "drop-fk", "drop-index"]);

    const emit2 = emit(evolve.changes, { dialect: "postgres", expectedSchema: expected2 });

    // The fix under test: DROP CONSTRAINT must precede DROP INDEX (the FK
    // depends on the index backing its target column) and both must precede
    // DROP COLUMN, in the emitted UP SQL — or the applyRaw below fails
    // against the real engine.
    const idxDropConstraint = emit2.up.indexOf("DROP CONSTRAINT");
    const idxDropIndex = emit2.up.indexOf("DROP INDEX");
    const idxDropColumn = emit2.up.indexOf("DROP COLUMN");
    expect(idxDropConstraint).toBeGreaterThanOrEqual(0);
    expect(idxDropIndex).toBeGreaterThanOrEqual(0);
    expect(idxDropColumn).toBeGreaterThanOrEqual(0);
    expect(idxDropConstraint).toBeLessThan(idxDropIndex);
    expect(idxDropIndex).toBeLessThan(idxDropColumn);

    // The real-engine gate: pre-fix (drop-fk/drop-index tied at the same
    // stage, both after drop-column, or drop-index ordered before drop-fk),
    // this throws one of:
    //   `error: cannot drop column code of table programs because other
    //   objects depend on it` (FK still referencing the column)
    //   `error: index "uniqueCode" does not exist` (index auto-cascaded away
    //   by an earlier DROP COLUMN)
    //   `error: cannot drop index "uniqueCode" because other objects depend
    //   on it` / `constraint weeks_program_code_fk … depends on index …`
    //   (index dropped before the FK constraint that depends on it)
    // Post-fix, it applies cleanly.
    await applyRaw(emit2.up);

    // Idempotence: re-introspecting must show no drift against expected2.
    const followup = await diff({ expected: expected2, actual: await introspectPostgres(k), dialect: "postgres" });
    if (followup.changes.length > 0) {
      console.error("ROUND-TRIP FAILURE — a second `meta migrate` would emit:");
      for (const c of followup.changes) console.error("  -", JSON.stringify(c));
    }
    expect(followup.changes).toEqual([]);
  });
});
