/**
 * Real-Postgres gate for the "adopting a legacy `serial` PK" bug.
 *
 * Adopting MetaObjects metadata onto an EXISTING Postgres table whose PK was
 * created as `serial` (Drizzle's `serial().primaryKey()`, Prisma's
 * `autoincrement()`, Rails, SQLAlchemy, or plain `id SERIAL PRIMARY KEY` — the
 * single most common pre-adoption shape) made `meta migrate --from-db` propose:
 *
 *   ALTER TABLE "work_item" ALTER COLUMN "id" DROP DEFAULT;
 *
 * with NO replacement generation mechanism emitted in the same migration.
 * Applying it leaves `id` NOT NULL with nothing to populate it, so every insert
 * that does not explicitly supply `id` starts failing — destructive against a
 * live table, and it fires on the first thing a new adopter does.
 *
 * A unit-level diff assertion on hand-built snapshots (diff-serial-identity-
 * default.test.ts) is not sufficient evidence that a REAL Postgres `serial`
 * column introspects into the exact shape the guard recognizes — this test
 * proves the whole pipeline against a live engine: create a real `SERIAL
 * PRIMARY KEY` table → introspect → diff against metadata declaring
 * `identity.primary @generation: increment` → the diff must NOT propose
 * DROP DEFAULT for `id` → apply whatever it DOES emit → re-introspect and
 * re-diff, which MUST come back empty (idempotence) → insert a row WITHOUT
 * supplying `id` and confirm it succeeds and auto-populates (the actual
 * value-semantics the bug broke).
 *
 * Gated on MIGRATE_TS_PG_URL like every other pg integration test here; skips
 * cleanly when unset. Reported against an adopting project.
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

// Metadata for the table an adopter would write on day one: the existing live
// `id` is `SERIAL PRIMARY KEY` (below), modeled as `field.int` +
// `identity.primary @generation: increment` — no `@default` (identity
// generation is modeled via `identity`, never `default`). `notes` does NOT
// exist on the live table yet, so the diff has a genuine `add-column` to
// apply — proving the round-trip does real work, not just a trivial no-op.
const META = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "WorkItem",
          children: [
            { "source.rdb": { "@table": "work_item" } },
            { "field.int": { name: "id" } },
            { "field.string": { name: "title", "@required": true } },
            { "field.string": { name: "notes" } },
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
  await sql.raw(`DROP TABLE IF EXISTS "work_item" CASCADE`).execute(k);
}

async function loadRoot(json: string) {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}

async function applyRaw(sqlText: string): Promise<void> {
  for (const stmt of sqlText.split(";").map((s) => s.trim()).filter((s) => s.length > 0)) {
    await sql.raw(stmt).execute(k);
  }
}

realDescribe("PG — adopting a legacy `serial` PK does not drop its default", () => {
  test("diff has no DROP DEFAULT for id; apply → re-diff empty; id-less insert succeeds", async () => {
    await cleanup();

    // A pre-existing table exactly as Drizzle's `serial().primaryKey()` (or plain
    // `id SERIAL PRIMARY KEY`) would have created it, BEFORE MetaObjects adoption.
    await sql
      .raw(`CREATE TABLE "work_item" ("id" SERIAL PRIMARY KEY, "title" text NOT NULL)`)
      .execute(k);

    const root = await loadRoot(META);
    const expected = buildExpectedSchema(root, { dialect: "postgres" });
    const actual = await introspectPostgres(k);

    // Confirm the premise: introspection reads the live column back as a real
    // `expr` default carrying the sequence's nextval(...) — proving the guard is
    // exercised against the true shape a live `serial` column produces, not a
    // hand-typed stand-in.
    const liveWorkItem = actual.tables.find((t) => t.name === "work_item");
    const liveId = liveWorkItem?.columns.find((c) => c.name === "id");
    expect(liveId?.identity).toBe("increment");
    expect(liveId?.default?.kind).toBe("expr");
    expect(liveId?.default?.value).toMatch(/^nextval\(/i);

    const result = await diff({ expected, actual, dialect: "postgres" });

    // The bug: this used to contain `change-column-default` for `id`, which the
    // postgres emitter renders as `ALTER COLUMN "id" DROP DEFAULT` with nothing to
    // replace it — the assertion that would have caught it BEFORE the fix.
    const idDefaultChange = result.changes.find(
      (c) => c.kind === "change-column-default" && c.column === "id",
    );
    expect(idDefaultChange).toBeUndefined();

    // Real adoption work remains: metadata declares `notes`, which the live table
    // doesn't have yet.
    expect(result.changes.some((c) => c.kind === "add-column" && c.column.name === "notes")).toBe(true);

    // Apply whatever the diff DID emit.
    const emitted = emit(result.changes, { dialect: "postgres" });
    await applyRaw(emitted.up);

    // Idempotence: re-introspect + re-diff must come back COMPLETELY empty.
    const actualAfter = await introspectPostgres(k);
    const resultAfter = await diff({ expected, actual: actualAfter, dialect: "postgres" });
    expect(resultAfter.changes).toEqual([]);

    // The value-semantics half of the gate — the thing the bug actually broke:
    // an insert that does NOT supply `id` must succeed and auto-populate it.
    const inserted = await sql<{ id: number; title: string }>`
      INSERT INTO "work_item" ("title") VALUES (${"a task with no explicit id"})
      RETURNING "id", "title"
    `.execute(k);
    expect(inserted.rows).toHaveLength(1);
    expect(inserted.rows[0]?.id).toBeGreaterThan(0);
    expect(inserted.rows[0]?.title).toBe("a task with no explicit id");
  });
});
