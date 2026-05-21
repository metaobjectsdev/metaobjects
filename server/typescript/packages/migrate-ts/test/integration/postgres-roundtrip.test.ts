/**
 * PG round-trip integration test — trainer-website fixture (load-bearing).
 *
 * Per spec §8.3 / §9 #4. Acceptance gate:
 *   build expected schema from metadata
 *   → diff against empty PG
 *   → emit up.sql
 *   → apply via raw SQL
 *   → re-introspect
 *   → re-diff MUST yield []
 *
 * Any remaining changes after apply indicate either lossy introspection or
 * wrong-shape emit; both block ship.
 *
 * This test requires a real Postgres instance (pg-mem lacks the
 * information_schema fidelity needed for a meaningful round-trip — see
 * postgres-introspect.test.ts for a detailed gap list). The test skips
 * gracefully when MIGRATE_TS_PG_URL is not set.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { MetaDataLoader, InMemorySource } from "@metaobjects/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspectPostgres } from "../../src/introspect/postgres.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PG_URL = process.env["MIGRATE_TS_PG_URL"];

function makeRealPgKysely(connectionString: string): {
  kysely: Kysely<Record<string, unknown>>;
  pool: Pool;
} {
  const pool = new Pool({ connectionString });
  const kysely = new Kysely<Record<string, unknown>>({
    dialect: new PostgresDialect({ pool }),
  });
  return { kysely, pool };
}

async function loadFixture(name: string) {
  const json = readFileSync(
    join(import.meta.dir, "..", "fixtures", `${name}.json`),
    "utf8",
  );
  return (await new MetaDataLoader().load([new InMemorySource(json)])).root;
}

/**
 * Execute each statement in a multi-statement SQL string separately.
 * Splits on ";" and skips blank/whitespace-only statements.
 */
async function applyRaw(
  k: Kysely<Record<string, unknown>>,
  sqlText: string,
): Promise<void> {
  for (const stmt of sqlText
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)) {
    await sql.raw(stmt).execute(k);
  }
}

// ---------------------------------------------------------------------------
// Fixture tables — dropped in the correct dependency order so that FK
// constraints don't block the DROP.  The order here is leaves → roots.
// ---------------------------------------------------------------------------

const FIXTURE_TABLES = [
  "exercises",
  "workouts",
  "weeks",
  "videos",
  "programs",
  "subscribers",
] as const;

async function dropFixtureTables(k: Kysely<Record<string, unknown>>): Promise<void> {
  for (const table of FIXTURE_TABLES) {
    await sql.raw(`DROP TABLE IF EXISTS ${table} CASCADE`).execute(k);
  }
}

// ---------------------------------------------------------------------------
// Test suite: create from empty
// ---------------------------------------------------------------------------

describe("PG round-trip — trainer-website fixture", () => {
  if (!PG_URL) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set (pg-mem lacks full information_schema fidelity)", () => {});
    return;
  }

  let kysely: Kysely<Record<string, unknown>>;
  let pool: Pool;

  beforeAll(async () => {
    const conn = makeRealPgKysely(PG_URL);
    kysely = conn.kysely;
    pool = conn.pool;
    // Ensure a clean slate before starting (idempotent re-run safety).
    await dropFixtureTables(kysely);
  });

  afterAll(async () => {
    // Leave the DB clean for future runs.
    await dropFixtureTables(kysely);
    await pool.end();
  });

  test("create from empty: apply → re-diff yields no changes", async () => {
    const metadata = await loadFixture("trainer-website-entities");

    // Step 1: Build the expected schema from metadata.
    const expected = buildExpectedSchema(metadata);
    expect(expected.tables).toHaveLength(6);

    // Step 2: Diff against empty DB — should want to create everything.
    const actual0 = await introspectPostgres(kysely);
    const initial = await diff(expected, actual0);
    expect(initial.blocked).toEqual([]);
    expect(initial.changes.length).toBeGreaterThan(0);

    // Step 3: Emit SQL and verify it is non-empty.
    const { up } = emit(initial.changes, { dialect: "postgres" });
    expect(up.length).toBeGreaterThan(0);

    // Step 4: Apply the emitted SQL.
    await applyRaw(kysely, up);

    // Step 5: Re-introspect and re-diff — MUST yield no changes.
    const actual1 = await introspectPostgres(kysely);
    const followup = await diff(expected, actual1);

    if (followup.changes.length > 0) {
      console.error("ROUND-TRIP FAILURE — remaining changes after apply:");
      for (const c of followup.changes) {
        console.error(`  - ${c.kind}:`, JSON.stringify(c, null, 2));
      }
    }

    expect(followup.changes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test suite: after metadata mutations
// ---------------------------------------------------------------------------

describe("PG round-trip — after metadata mutations", () => {
  if (!PG_URL) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    return;
  }

  let kysely: Kysely<Record<string, unknown>>;
  let pool: Pool;

  beforeAll(async () => {
    const conn = makeRealPgKysely(PG_URL);
    kysely = conn.kysely;
    pool = conn.pool;
  });

  afterAll(async () => {
    await dropFixtureTables(kysely);
    await pool.end();
  });

  test("add a field → migration applies → re-diff yields no changes", async () => {
    // Fresh slate for this test.
    await dropFixtureTables(kysely);

    // Apply initial migration from the base fixture.
    const metadata1 = await loadFixture("trainer-website-entities");
    {
      const initial = await diff(buildExpectedSchema(metadata1), await introspectPostgres(kysely));
      const { up } = emit(initial.changes, { dialect: "postgres" });
      await applyRaw(kysely, up);
    }

    // Mutation: parse the fixture JSON, append a `phone` field to Subscriber.
    const json = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "fixtures", "trainer-website-entities.json"), "utf8"),
    );
    const subscriber = json["metadata.root"].children.find(
      (c: { "object.entity"?: { name: string } }) => c["object.entity"]?.name === "Subscriber",
    )["object.entity"];
    subscriber.children.push({ "field.string": { name: "phone" } });
    const metadata2 = (await new MetaDataLoader().load([new InMemorySource(JSON.stringify(json))])).root;

    // Second diff should detect one add-column.
    const second = await diff(buildExpectedSchema(metadata2), await introspectPostgres(kysely));
    expect(second.blocked).toEqual([]);
    expect(second.changes.find((c) => c.kind === "add-column")).toBeDefined();

    // Apply and verify the round-trip closes.
    const { up: up2 } = emit(second.changes, { dialect: "postgres" });
    await applyRaw(kysely, up2);

    const followup = await diff(buildExpectedSchema(metadata2), await introspectPostgres(kysely));
    if (followup.changes.length > 0) {
      console.error("ROUND-TRIP FAILURE (add-column) — remaining changes:");
      for (const c of followup.changes) console.error(`  - ${c.kind}:`, JSON.stringify(c, null, 2));
    }
    expect(followup.changes).toEqual([]);
  });

  test("drop a field with allow.dropColumn → migration applies → re-diff yields no changes", async () => {
    // Fresh slate for this test.
    await dropFixtureTables(kysely);

    // Parse base fixture and apply initial migration.
    const json = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "fixtures", "trainer-website-entities.json"), "utf8"),
    );
    const metadata1 = (await new MetaDataLoader().load([new InMemorySource(JSON.stringify(json))])).root;
    {
      const initial = await diff(buildExpectedSchema(metadata1), await introspectPostgres(kysely));
      const { up } = emit(initial.changes, { dialect: "postgres" });
      await applyRaw(kysely, up);
    }

    // Mutation: remove Subscriber.source field.
    const subscriber = json["metadata.root"].children.find(
      (c: { "object.entity"?: { name: string } }) => c["object.entity"]?.name === "Subscriber",
    )["object.entity"];
    subscriber.children = subscriber.children.filter(
      (ch: { "field.string"?: { name: string } }) => ch["field.string"]?.name !== "source",
    );
    const metadata2 = (await new MetaDataLoader().load([new InMemorySource(JSON.stringify(json))])).root;

    // Second diff should detect one drop-column (allowed).
    const second = await diff(buildExpectedSchema(metadata2), await introspectPostgres(kysely), {
      allow: { dropColumn: true },
    });
    expect(second.blocked).toEqual([]);
    expect(second.changes.find((c) => c.kind === "drop-column" && c.column === "source")).toBeDefined();

    // Apply and verify the round-trip closes.
    const { up: up2 } = emit(second.changes, { dialect: "postgres" });
    await applyRaw(kysely, up2);

    const followup = await diff(buildExpectedSchema(metadata2), await introspectPostgres(kysely));
    if (followup.changes.length > 0) {
      console.error("ROUND-TRIP FAILURE (drop-column) — remaining changes:");
      for (const c of followup.changes) console.error(`  - ${c.kind}:`, JSON.stringify(c, null, 2));
    }
    expect(followup.changes).toEqual([]);
  });

  test("rename column via onAmbiguous callback → migration applies → re-diff yields no changes", async () => {
    // Fresh slate for this test.
    await dropFixtureTables(kysely);

    // Parse base fixture and apply initial migration.
    const json = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "fixtures", "trainer-website-entities.json"), "utf8"),
    );
    const metadata1 = (await new MetaDataLoader().load([new InMemorySource(JSON.stringify(json))])).root;
    {
      const initial = await diff(buildExpectedSchema(metadata1), await introspectPostgres(kysely));
      const { up } = emit(initial.changes, { dialect: "postgres" });
      await applyRaw(kysely, up);
    }

    // Mutation: rename Subscriber.firstName → first_name_2.
    // The DB has column "first_name"; the new metadata produces "first_name_2".
    // Levenshtein("first_name", "first_name_2") = 2, threshold = max(2, floor(10/3)) = 3 → within threshold.
    const subscriber = json["metadata.root"].children.find(
      (c: { "object.entity"?: { name: string } }) => c["object.entity"]?.name === "Subscriber",
    )["object.entity"];
    const fnField = subscriber.children.find(
      (ch: { "field.string"?: { name: string } }) => ch["field.string"]?.name === "firstName",
    );
    fnField["field.string"].name = "first_name_2";
    const metadata2 = (await new MetaDataLoader().load([new InMemorySource(JSON.stringify(json))])).root;

    // Second diff via object form so we can pass onAmbiguous.
    const second = await diff({
      expected: buildExpectedSchema(metadata2),
      actual: await introspectPostgres(kysely),
      onAmbiguous: async () => "rename",
    });
    expect(second.changes.find((c) => c.kind === "rename-column")).toBeDefined();

    // Apply and verify the round-trip closes.
    const { up: up2 } = emit(second.changes, { dialect: "postgres" });
    await applyRaw(kysely, up2);

    const followup = await diff(buildExpectedSchema(metadata2), await introspectPostgres(kysely));
    if (followup.changes.length > 0) {
      console.error("ROUND-TRIP FAILURE (rename-column) — remaining changes:");
      for (const c of followup.changes) console.error(`  - ${c.kind}:`, JSON.stringify(c, null, 2));
    }
    expect(followup.changes).toEqual([]);
  });
});
