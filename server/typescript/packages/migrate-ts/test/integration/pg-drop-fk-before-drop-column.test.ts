/**
 * Real-Postgres gate for #255 — "a table whose column is referenced by
 * another table's FK, where the metadata drops both the FK and the column."
 *
 * Root cause: the emitter's STAGE_ORDER put `drop-column` (stage 2) before
 * `drop-fk` (stage 5), so the emitted UP SQL issued
 * `ALTER TABLE "programs" DROP COLUMN "code"` while `weeks_program_code_fk` —
 * another table's FK constraint referencing that column — still existed.
 * Postgres refuses: "cannot drop column code of table programs because other
 * objects depend on it." The fix hoists `drop-fk`/`drop-check` to a stage
 * before column mutation; this test proves the reordered SQL actually applies
 * against a real engine (a unit assertion on statement order alone is not
 * sufficient evidence — see emit-postgres.test.ts for that half).
 *
 * A third, INCIDENTAL finding surfaced while building this scenario: the FK's
 * target column must be unique (Postgres requirement), so dropping it also
 * drops its backing `identity.secondary` index. Postgres auto-cascades that
 * index away together with the column (same as it does for the table's own
 * FK/CHECK constraints) — so a SEPARATE, explicit `DROP INDEX` for it is
 * redundant and fails post-cascade ("index … does not exist") regardless of
 * the #255 fix. That is a distinct latent ordering interaction between
 * drop-column and drop-index — NOT part of #255's drop-fk/drop-check scope,
 * unverified beyond this single observation, and deliberately NOT fixed here.
 * This test isolates #255 by excluding that drop-index change from the
 * applied change-set (still real DDL, real engine — just not conflating two
 * bugs in one assertion).
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

// V2: Program drops `code` (+ its identity.secondary); Week drops the FK
// (identity.reference) but keeps its own `programCode` column (now a plain,
// un-constrained column) — the exact shape that produces a drop-fk +
// drop-column pair where the dropped column is the FK's REFERENCED side.
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

realDescribe("PG #255 — drop-fk before drop-column applies cleanly", () => {
  test("dropping an FK's referenced column + the FK itself: emitted SQL applies, re-diff empty", async () => {
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

    // Evolve to v2: drop Program.code (the FK's referenced column) AND the
    // FK itself, in one change-set.
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

    // Exclude drop-index — see file header. Postgres auto-cascades the
    // identity.secondary's backing index away together with its column, so a
    // separate explicit DROP INDEX for it is redundant (and fails
    // post-cascade). That is an unrelated latent interaction, not #255's
    // drop-fk/drop-check scope; excluding it here isolates the fix under
    // test without silently asserting a fix for a bug this change doesn't
    // touch.
    const changesUnderTest = evolve.changes.filter((c) => c.kind !== "drop-index");
    const emit2 = emit(changesUnderTest, { dialect: "postgres", expectedSchema: expected2 });

    // The fix under test: DROP CONSTRAINT must precede DROP COLUMN in the
    // emitted UP SQL, or the applyRaw below fails against the real engine.
    const idxDropConstraint = emit2.up.indexOf("DROP CONSTRAINT");
    const idxDropColumn = emit2.up.indexOf("DROP COLUMN");
    expect(idxDropConstraint).toBeGreaterThanOrEqual(0);
    expect(idxDropColumn).toBeGreaterThanOrEqual(0);
    expect(idxDropConstraint).toBeLessThan(idxDropColumn);

    // The real-engine gate: pre-fix, this throws
    // `error: cannot drop column code of table programs because other
    // objects depend on it`. Post-fix, it applies cleanly.
    await applyRaw(emit2.up);

    // Idempotence: re-introspecting must show no drift against expected2 —
    // proving the index (never explicitly dropped) is genuinely gone too,
    // cascaded away by the column drop, not just skipped.
    const followup = await diff({ expected: expected2, actual: await introspectPostgres(k), dialect: "postgres" });
    if (followup.changes.length > 0) {
      console.error("ROUND-TRIP FAILURE — a second `meta migrate` would emit:");
      for (const c of followup.changes) console.error("  -", JSON.stringify(c));
    }
    expect(followup.changes).toEqual([]);
  });
});
