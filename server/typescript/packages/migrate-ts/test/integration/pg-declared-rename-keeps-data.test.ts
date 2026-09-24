/**
 * A declared column rename keeps the data in a POPULATED table.
 *
 * `origin_city` → `origin_port` is too far apart for the rename heuristic, so without a
 * declaration the migration is DROP COLUMN + ADD COLUMN and every value is gone. An adopter
 * estate hit this and hand-edited the emitted SQL. With `renames` declared the migration is
 * a RENAME COLUMN, the rows keep their values, and the re-diff is empty.
 *
 * Also proves a hazard-annotated statement still applies: the WARNING comment the emitter
 * writes above `SET NOT NULL` must not break the statement splitter or Postgres.
 *
 * Real engine, per this package's doctrine. Skips when MIGRATE_TS_PG_URL is not set.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspectPostgres } from "../../src/introspect/postgres.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";
import { splitSqlStatements } from "../../src/sql/split-statements.js";
import type { SchemaSnapshot } from "../../src/types.js";

const PG_URL = process.env["MIGRATE_TS_PG_URL"];
const TABLE = "dr_shipment";

function model(originColumn: string, carrierRequired: boolean): string {
  return JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [{
        "object.entity": {
          name: "Shipment",
          children: [
            { "source.rdb": { "@table": TABLE } },
            { "field.int": { name: "id" } },
            { "field.string": { name: "origin", "@column": originColumn } },
            { "field.string": { name: "carrier", "@required": carrierRequired } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      }],
    },
  });
}

async function expectedFor(originColumn: string, carrierRequired: boolean): Promise<SchemaSnapshot> {
  const loaded = await new MetaDataLoader().load([new InMemoryStringSource(model(originColumn, carrierRequired))]);
  expect(loaded.errors).toEqual([]);
  return buildExpectedSchema(loaded.root, { dialect: "postgres" });
}

describe("a declared column rename keeps the data (PG)", () => {
  if (!PG_URL) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    return;
  }

  let kysely: Kysely<Record<string, unknown>>;
  let pool: Pool;
  const drop = async (): Promise<void> => {
    await sql.raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`).execute(kysely);
  };
  const apply = async (text: string): Promise<void> => {
    for (const stmt of splitSqlStatements(text)) await sql.raw(stmt).execute(kysely);
  };
  const actual = async (): Promise<SchemaSnapshot> => {
    const s = await introspectPostgres(kysely);
    return { ...s, tables: s.tables.filter((t) => t.name === TABLE), views: [] };
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    kysely = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool }) });
    await drop();
  });
  afterAll(async () => {
    await drop();
    await pool.end();
  });

  test("RENAME COLUMN, not drop+add: the rows keep their values and the re-diff is empty", async () => {
    await drop();
    const create = await diff({ expected: await expectedFor("origin_city", false), actual: await actual(), dialect: "postgres" });
    await apply(emit(create.changes, { dialect: "postgres" }).up);
    await sql.raw(`INSERT INTO ${TABLE} (id, origin_city, carrier) VALUES (1, 'Rotterdam', 'Maersk'), (2, 'Hamburg', NULL)`).execute(kysely);

    const target = await expectedFor("origin_port", false);
    const r = await diff({
      expected: target, actual: await actual(), dialect: "postgres",
      renames: [{ kind: "column", table: TABLE, from: "origin_city", to: "origin_port" }],
    });
    expect(r.changes.map((c) => c.kind)).toEqual(["rename-column"]);
    await apply(emit(r.changes, { dialect: "postgres" }).up);

    const rows = await sql.raw<{ id: number; origin_port: string }>(`SELECT id, origin_port FROM ${TABLE} ORDER BY id`).execute(kysely);
    expect(rows.rows).toEqual([{ id: 1, origin_port: "Rotterdam" }, { id: 2, origin_port: "Hamburg" }]);
    expect((await diff({ expected: target, actual: await actual(), dialect: "postgres" })).changes).toEqual([]);
  });

  test("a hazard-annotated SET NOT NULL applies once the backfill it names has run", async () => {
    const target = await expectedFor("origin_port", true);
    const r = await diff({ expected: target, actual: await actual(), dialect: "postgres", allow: { nullableToNotNull: true } });
    expect(r.hazards).toEqual([{ kind: "set-not-null", table: TABLE, column: "carrier" }]);
    const up = emit(r.changes, { dialect: "postgres" }).up;
    expect(up).toContain("-- WARNING: fails if any row of");

    // As written, the populated table refuses it — the hazard is real.
    await expect(apply(up)).rejects.toThrow(/null/i);
    // Run the backfill the comment names, then the same file applies.
    await sql.raw(`UPDATE ${TABLE} SET carrier = 'unknown' WHERE carrier IS NULL`).execute(kysely);
    await apply(up);
    expect((await diff({ expected: target, actual: await actual(), dialect: "postgres" })).changes).toEqual([]);
  });
});
