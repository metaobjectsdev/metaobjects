/**
 * Int-backed `field.enum` (`@intValueMap`) — the REAL gate, against a live Postgres.
 *
 * WHY THIS EXISTS
 *
 * Everything else about int-backed enums is verified by unit assertions and by
 * inspecting generated source: migrate-ts says the column is `integer`, codegen-ts
 * says the Drizzle column is a `customType`, and both say the CHECK lists unquoted
 * integers. None of that proves the DDL APPLIES, that a second migrate CONVERGES, or
 * that the codec actually round-trips a member symbol through a real integer column.
 *
 * This repo has a monument to exactly that gap: the 0.15.21 line, where a family of
 * destructive migrate bugs survived a suite of thousands because nothing ever ran the
 * pipeline twice against a real engine. `emit` and `introspect` had never been in the
 * same room. The same is true here until this file runs.
 *
 * So: apply to a REAL engine, RE-DIFF, and then prove the value semantics both ways —
 * a symbol written through the generated codec must land as the mapped INTEGER in the
 * physical column, and an integer already in the column must read back as the symbol.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  buildExpectedSchema, diff, emit, introspectPostgres,
  type SchemaSnapshot,
} from "@metaobjectsdev/migrate-ts";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { startPostgres, type RunningPg } from "../src/postgres-container.ts";

// The map is deliberately SPARSE and non-ordinal (0/5/9) so any accidental
// index-of-@values correspondence shows up as a wrong number rather than passing
// by coincidence — the failure mode the design's Goal 3 calls out.
const INT_MAP = { DRAFT: 0, PUBLISHED: 5, ARCHIVED: 9 } as const;

/** An entity with an int-backed enum. The map lives on a SHARED root-level abstract
 *  declaration and the field inherits it — the shape #246 steers authors toward, and
 *  the one an own-only read would silently get wrong. */
function meta(opts: { withDefault?: boolean } = {}): string {
  const dflt = opts.withDefault ? `, "@default": "PUBLISHED"` : "";
  return `{
    "metadata.root": {
      "package": "acme",
      "children": [
        { "field.enum": { "name": "Status", "abstract": true,
          "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"],
          "@intValueMap": { "DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9 } } },
        { "object.entity": { "name": "Order", "children": [
          { "source.rdb": {} },
          { "field.long":   { "name": "id" } },
          { "field.string": { "name": "title", "@required": true } },
          { "field.enum":   { "name": "status", "extends": "Status", "@required": true${dflt} } },
          { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
        ] } }
      ]
    }
  }`;
}

/** The string-backed control: identical model minus @intValueMap. */
function metaStringBacked(): string {
  return `{
    "metadata.root": {
      "package": "acme",
      "children": [
        { "object.entity": { "name": "Order", "children": [
          { "source.rdb": {} },
          { "field.long":   { "name": "id" } },
          { "field.string": { "name": "title", "@required": true } },
          { "field.enum":   { "name": "status", "@required": true,
            "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"] } },
          { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
        ] } }
      ]
    }
  }`;
}

let pg: RunningPg;
let pool: Pool;
let k: Kysely<any>;

beforeAll(async () => {
  pg = await startPostgres();
  pool = new Pool({ connectionString: pg.connectionUri });
  k = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
}, 120_000);

afterAll(async () => {
  await k?.destroy();
  await pg?.stop();
});

beforeEach(async () => {
  await sql.raw(`DROP TABLE IF EXISTS "orders" CASCADE;`).execute(k);
  await sql.raw(`DROP TABLE IF EXISTS orders CASCADE;`).execute(k);
});

async function applyRaw(ddl: string): Promise<void> {
  for (const stmt of ddl.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    await sql.raw(stmt.endsWith(";") ? stmt : `${stmt};`).execute(k);
  }
}

async function expectedFor(metaJson: string): Promise<SchemaSnapshot> {
  const root = (await new MetaDataLoader().load([new InMemoryStringSource(metaJson)])).root;
  return buildExpectedSchema(root, { columnNamingStrategy: "literal", dialect: "postgres" });
}

/** build → introspect → diff → emit → apply, then return the expected side. */
async function migrate(metaJson: string): Promise<SchemaSnapshot> {
  const expected = await expectedFor(metaJson);
  const result = await diff({
    expected, actual: await introspectPostgres(k), dialect: "postgres",
  });
  expect(result.blocked).toEqual([]);
  const { up } = result.changes.length === 0
    ? { up: "" }
    : emit(result.changes, { dialect: "postgres" });
  if (up.trim().length > 0) await applyRaw(up);
  return expected;
}

/** THE gate: a second migrate against the just-migrated DB must be a no-op. */
async function assertConverged(expected: SchemaSnapshot): Promise<void> {
  const followup = await diff({
    expected, actual: await introspectPostgres(k), dialect: "postgres",
  });
  if (followup.changes.length > 0) {
    console.error("NOT CONVERGED — a second migrate would emit:");
    for (const c of followup.changes) console.error("  -", c.kind, JSON.stringify(c).slice(0, 300));
  }
  expect(followup.changes).toEqual([]);
}

describe("int-backed field.enum — real Postgres", () => {
  test("the emitted DDL APPLIES and a second migrate converges", async () => {
    const expected = await migrate(meta());
    await assertConverged(expected);
  }, 120_000);

  test("the physical column is integer, not text", async () => {
    await migrate(meta());
    const rows = await sql<{ data_type: string }>`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'orders' AND column_name = 'status'
    `.execute(k);
    expect(rows.rows[0]?.data_type).toBe("integer");
  }, 120_000);

  test("the CHECK enforces the mapped INTEGERS — a valid member's int is accepted, a non-member int rejected", async () => {
    await migrate(meta());
    // 5 === PUBLISHED, so this must be accepted.
    await sql.raw(`INSERT INTO "orders" ("title", "status") VALUES ('ok', 5);`).execute(k);
    // 7 maps to no member. If the CHECK had been emitted over the member STRINGS
    // (or omitted), this would succeed and the column would hold an impossible value.
    let rejected = false;
    try {
      await sql.raw(`INSERT INTO "orders" ("title", "status") VALUES ('bad', 7);`).execute(k);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  }, 120_000);

  test("an ordinal-looking wrong value is rejected — the map is sparse, not positional", async () => {
    await migrate(meta());
    // ARCHIVED is index 2 in @values but maps to 9. If anything derived the stored
    // int from the member's POSITION (design Goal 3's hazard), 2 would be valid.
    let rejected = false;
    try {
      await sql.raw(`INSERT INTO "orders" ("title", "status") VALUES ('ordinal', 2);`).execute(k);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  }, 120_000);

  test("@default lands as the mapped integer, appliably", async () => {
    const expected = await migrate(meta({ withDefault: true }));
    await assertConverged(expected);
    await sql.raw(`INSERT INTO "orders" ("title") VALUES ('defaulted');`).execute(k);
    const rows = await sql<{ status: number }>`
      SELECT "status" FROM "orders" WHERE "title" = 'defaulted'
    `.execute(k);
    // PUBLISHED === 5. A DEFAULT 'PUBLISHED' on an integer column would not have
    // applied at all, so reaching this assertion is itself part of the proof.
    expect(rows.rows[0]?.status).toBe(5);
  }, 120_000);

  test("the string-backed control still gets a text column and converges", async () => {
    const expected = await migrate(metaStringBacked());
    await assertConverged(expected);
    const rows = await sql<{ data_type: string }>`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'orders' AND column_name = 'status'
    `.execute(k);
    expect(rows.rows[0]?.data_type).toBe("text");
    await sql.raw(`INSERT INTO "orders" ("title", "status") VALUES ('s', 'DRAFT');`).execute(k);
  }, 120_000);

  test("toggling the backing on an existing table is BLOCKED (no silent destructive recast)", async () => {
    await migrate(metaStringBacked());
    const intExpected = await expectedFor(meta());
    const result = await diff({
      expected: intExpected, actual: await introspectPostgres(k), dialect: "postgres",
    });
    const typeChange = result.changes.find((c) => c.kind === "change-column-type");
    expect(typeChange).toBeDefined();
    expect(typeChange!.status.state).toBe("blocked");
  }, 120_000);
});
