/**
 * Real-Postgres gate for the "undeclared @generation against a live serial PK"
 * gap left open by #279.
 *
 * #279 (see pg-serial-identity-adoption.test.ts) stopped `meta migrate` from
 * proposing a destructive `ALTER COLUMN "id" DROP DEFAULT` against a live
 * legacy `serial` PK — but ONLY when the metadata explicitly declares
 * `identity.primary @generation: increment`. `buildExpectedSchema` sets
 * `ColumnDescriptor.identity` exclusively from a declared `@generation`
 * (expected-schema.ts) — there is no default — so an adopter who writes
 * `identity.primary` with NO `@generation` against a live `serial` PK gets
 * `ec.identity === undefined`, the #279 guard never engages, and the same
 * destructive drop reaches the diff as an ordinary, ALLOWED
 * `change-column-default`.
 *
 * We deliberately do NOT widen the #279 guard to key off the LIVE column
 * instead ("if it's serial, never touch its default") — that would silently
 * refuse a DELIBERATE migration off auto-increment (e.g. moving to
 * app-assigned ULIDs, which drops `@generation` precisely because the author
 * wants the sequence gone). "No @generation declared" is genuinely ambiguous
 * between "never declared it" and "deliberately removing it", so instead of
 * guessing, migrate refuses and asks — same shape as #258 (refuse a PK move
 * rather than emit an un-appliable migration).
 *
 * A unit-level diff assertion on hand-built snapshots
 * (diff-status-identity-default.test.ts) is not sufficient evidence that a
 * REAL Postgres `serial` column introspects into the exact shape the guard
 * recognizes — this test proves the whole pipeline against a live engine:
 * create a real `SERIAL PRIMARY KEY` table → introspect → diff against
 * metadata declaring `identity.primary` WITHOUT `@generation` → the change
 * must be BLOCKED, naming both remedies → confirm `--allow
 * drop-identity-default` (allow.dropIdentityDefault) lets the DROP DEFAULT
 * through and it actually applies.
 *
 * Gated on MIGRATE_TS_PG_URL like every other pg integration test here; skips
 * cleanly when unset.
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

// Same live pre-adoption shape as pg-serial-identity-adoption.test.ts, but the
// metadata here deliberately OMITS `@generation` — the ambiguous case.
const META_NO_GENERATION = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "Task",
          children: [
            { "source.rdb": { "@table": "task" } },
            { "field.int": { name: "id" } },
            { "field.string": { name: "title", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
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
  await sql.raw(`DROP TABLE IF EXISTS "task" CASCADE`).execute(k);
}

async function loadRoot(json: string) {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}

async function createLiveSerialTable(): Promise<void> {
  await cleanup();
  await sql
    .raw(`CREATE TABLE "task" ("id" SERIAL PRIMARY KEY, "title" text NOT NULL)`)
    .execute(k);
}

realDescribe("PG — undeclared @generation against a live serial PK refuses, not guesses", () => {
  test("diff blocks change-column-default on id, naming both remedies", async () => {
    await createLiveSerialTable();

    const root = await loadRoot(META_NO_GENERATION);
    const expected = buildExpectedSchema(root, { dialect: "postgres" });
    const actual = await introspectPostgres(k);

    // Confirm the premise: the expected side declares NO identity at all (no
    // @generation was written), while the live column really does carry an
    // auto-sequence default — proving the ambiguous case is exercised against
    // the true shape a live `serial` column produces.
    const expectedId = expected.tables.find((t) => t.name === "task")?.columns.find((c) => c.name === "id");
    expect(expectedId?.identity).toBeUndefined();
    const liveId = actual.tables.find((t) => t.name === "task")?.columns.find((c) => c.name === "id");
    expect(liveId?.identity).toBe("increment");
    expect(liveId?.default?.value).toMatch(/^nextval\(/i);

    const result = await diff({ expected, actual, dialect: "postgres" });

    const idDefaultChange = result.changes.find(
      (c) => c.kind === "change-column-default" && c.column === "id",
    );
    expect(idDefaultChange).toBeDefined();
    expect(idDefaultChange!.status.state).toBe("blocked");
    expect(result.blocked).toContain(idDefaultChange!);

    const reason = idDefaultChange!.status.blockedReason ?? "";
    expect(reason).toContain("task");
    expect(reason).toContain("id");
    expect(reason).toContain("@generation: increment");
    expect(reason).toContain("--allow drop-identity-default");

    // emit() must refuse to hand back applicable SQL for a blocked diff.
    expect(() => emit(result.changes, { dialect: "postgres" })).toThrow();
  });

  test("allow.dropIdentityDefault lets the DROP DEFAULT through and it actually applies", async () => {
    await createLiveSerialTable();

    const root = await loadRoot(META_NO_GENERATION);
    const expected = buildExpectedSchema(root, { dialect: "postgres" });
    const actual = await introspectPostgres(k);

    const result = await diff({
      expected,
      actual,
      dialect: "postgres",
      allow: { dropIdentityDefault: true },
    });

    const idDefaultChange = result.changes.find(
      (c) => c.kind === "change-column-default" && c.column === "id",
    );
    expect(idDefaultChange).toBeDefined();
    expect(idDefaultChange!.status.state).toBe("allowed");
    expect(result.blocked).toHaveLength(0);

    const emitted = emit(result.changes, { dialect: "postgres" });
    expect(emitted.up).toMatch(/ALTER COLUMN "id" DROP DEFAULT/i);

    for (const stmt of emitted.up.split(";").map((s) => s.trim()).filter((s) => s.length > 0)) {
      await sql.raw(stmt).execute(k);
    }

    const actualAfter = await introspectPostgres(k);
    const liveIdAfter = actualAfter.tables.find((t) => t.name === "task")?.columns.find((c) => c.name === "id");
    expect(liveIdAfter?.default).toBeUndefined();

    // An id-less insert now fails — proving the default really is gone (the
    // exact real-world consequence the refusal exists to prevent unless
    // deliberately chosen).
    await expect(
      sql`INSERT INTO "task" ("title") VALUES (${"no id supplied"})`.execute(k),
    ).rejects.toThrow();
  });
});
