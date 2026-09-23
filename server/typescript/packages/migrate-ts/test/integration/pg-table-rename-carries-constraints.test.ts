/**
 * A table rename carries its indexes and constraints — the migration must not re-create them.
 *
 * `ALTER TABLE … RENAME TO` keeps every index, foreign key and CHECK the table owns, and every
 * foreign key on OTHER tables that points at it. `meta migrate --on-ambiguous rename` used to
 * turn the create-table half of the drop/create pair into a rename-table and then keep the
 * create half's `CREATE INDEX` / `ADD CONSTRAINT` statements anyway, so the replay died on
 * `relation "<index>" already exists`. Nothing compared the renamed table against its new
 * declaration at all, so:
 *
 *   - an explicitly-named index or unique key was created a second time (the replay failure);
 *   - a constraint whose name derives from the table (`<table>_<col>_fk`, `<table>_<col>_chk`)
 *     kept its old name, so the re-diff proposed dropping it as unmanaged;
 *   - the down migration dropped the original indexes before renaming the table back.
 *
 * Found by an adopter estate: a model rename `Leg` → `ShipmentLeg` with `@table: shipment_leg`.
 *
 * Real engine, per this package's doctrine: apply up, re-introspect, re-diff MUST be empty;
 * apply down, re-diff against the ORIGINAL model MUST be empty; the carried constraints must
 * still enforce.
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
import type { SchemaSnapshot } from "../../src/types.js";

const PG_URL = process.env["MIGRATE_TS_PG_URL"];

const TABLES = ["rn_stop", "rn_leg", "rn_shipment_leg", "rn_shipment"];

/** The model with the leg table, its lookup index and its unique key named as given. Everything else is identical. */
function model(legTable: string, sequenceIndex: string, uniqueKey: string): string {
  return JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [
        {
          "object.entity": {
            name: "Shipment",
            children: [
              { "source.rdb": { "@table": "rn_shipment" } },
              { "field.uuid": { name: "id" } },
              { "field.string": { name: "reference", "@required": true } },
              { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "uuid" } },
            ],
          },
        },
        {
          "object.entity": {
            name: "Leg",
            children: [
              { "source.rdb": { "@table": legTable } },
              { "field.uuid": { name: "id" } },
              { "field.uuid": { name: "shipmentId", "@column": "shipment_id", "@required": true } },
              { "field.int": { name: "sequence", "@required": true } },
              { "field.enum": { name: "mode", "@required": true, "@values": ["TRUCK", "RAIL"] } },
              { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "uuid" } },
              {
                "identity.reference": {
                  name: "shipmentRef", "@fields": ["shipmentId"], "@references": "Shipment",
                  "@onDelete": "cascade",
                },
              },
              { "identity.secondary": { name: uniqueKey, "@fields": ["shipmentId", "sequence"] } },
              { "index.lookup": { name: sequenceIndex, "@fields": ["sequence"] } },
            ],
          },
        },
        {
          // A table that REFERENCES the renamed one: its FK follows the rename in the engine.
          "object.entity": {
            name: "Stop",
            children: [
              { "source.rdb": { "@table": "rn_stop" } },
              { "field.uuid": { name: "id" } },
              { "field.uuid": { name: "legId", "@column": "leg_id", "@required": true } },
              { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "uuid" } },
              { "identity.reference": { name: "legRef", "@fields": ["legId"], "@references": "Leg" } },
            ],
          },
        },
      ],
    },
  });
}

async function expectedFor(legTable: string, sequenceIndex: string, uniqueKey: string): Promise<SchemaSnapshot> {
  const loaded = await new MetaDataLoader().load(
    [new InMemoryStringSource(model(legTable, sequenceIndex, uniqueKey))],
  );
  expect(loaded.errors).toEqual([]);
  return buildExpectedSchema(loaded.root, { dialect: "postgres" });
}

async function applyRaw(k: Kysely<Record<string, unknown>>, sqlText: string): Promise<void> {
  // One statement per call; the emitter separates statements with a blank line.
  for (const stmt of sqlText.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s.length > 0)) {
    await sql.raw(stmt).execute(k);
  }
}

describe("a table rename carries its indexes and constraints (PG)", () => {
  if (!PG_URL) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    return;
  }

  let kysely: Kysely<Record<string, unknown>>;
  let pool: Pool;

  const dropAll = async (): Promise<void> => {
    for (const t of TABLES) await sql.raw(`DROP TABLE IF EXISTS ${t} CASCADE`).execute(kysely);
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    kysely = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool }) });
    await dropAll();
  });

  afterAll(async () => {
    await dropAll();
    await pool.end();
  });

  test("REGRESSION: rename up and down both apply, converge, and keep enforcement", async () => {
    await dropAll();
    // The unique key keeps its name, so a re-create would collide ("already exists"); the
    // lookup index is renamed alongside the table, exercising the index-rename fold.
    const before = await expectedFor("rn_leg", "idxLegSequence", "uqLegShipmentSeq");
    const after = await expectedFor("rn_shipment_leg", "idxShipmentLegSequence", "uqLegShipmentSeq");

    // Build the original schema through the tool itself.
    const create = await diff({ expected: before, actual: await introspectPostgres(kysely), dialect: "postgres" });
    await applyRaw(kysely, emit(create.changes, { dialect: "postgres" }).up);

    const d = await diff({
      expected: after,
      actual: await introspectPostgres(kysely),
      dialect: "postgres",
      onAmbiguous: async () => "rename",
    });
    const { up, down } = emit(d.changes, { dialect: "postgres" });

    // The rename carries the explicitly-named indexes and every FK: nothing is re-created.
    expect(up).toContain(`ALTER TABLE "rn_leg" RENAME TO "rn_shipment_leg";`);
    expect(up).not.toMatch(/CREATE (UNIQUE )?INDEX/);
    expect(up).not.toMatch(/ADD CONSTRAINT/);
    expect(up).not.toMatch(/DROP CONSTRAINT/);
    // Table-derived constraint names follow the table.
    expect(up).toContain(`RENAME CONSTRAINT "rn_leg_shipment_id_fk" TO "rn_shipment_leg_shipment_id_fk"`);
    expect(up).toContain(`RENAME CONSTRAINT "rn_leg_mode_chk" TO "rn_shipment_leg_mode_chk"`);
    // An index renamed in the same model change is renamed, not dropped and rebuilt.
    expect(up).toContain(`ALTER INDEX "idxLegSequence" RENAME TO "idxShipmentLegSequence"`);
    expect(up).not.toMatch(/DROP INDEX/);
    // The down renames back; it never drops what the table carried.
    expect(down).not.toMatch(/DROP (INDEX|CONSTRAINT)/);

    // Pre-fix: relation "uqLegShipmentSeq" already exists.
    await applyRaw(kysely, up);

    // CONVERGENCE after up.
    const reDiff = await diff({ expected: after, actual: await introspectPostgres(kysely), dialect: "postgres" });
    expect(reDiff.changes.map((c) => c.kind)).toEqual([]);

    // VALUE SEMANTICS — the carried unique key, CHECK and FKs still enforce.
    const shipmentId = "00000000-0000-0000-0000-000000000001";
    await sql.raw(`INSERT INTO rn_shipment (id, reference) VALUES ('${shipmentId}', 'S-1')`).execute(kysely);
    await sql.raw(
      `INSERT INTO rn_shipment_leg (id, shipment_id, sequence, mode)
       VALUES ('00000000-0000-0000-0000-00000000000a', '${shipmentId}', 1, 'TRUCK')`,
    ).execute(kysely);
    await expect(sql.raw(
      `INSERT INTO rn_shipment_leg (id, shipment_id, sequence, mode)
       VALUES ('00000000-0000-0000-0000-00000000000b', '${shipmentId}', 1, 'RAIL')`,
    ).execute(kysely)).rejects.toThrow(/unique|duplicate key/i);
    await expect(sql.raw(
      `INSERT INTO rn_shipment_leg (id, shipment_id, sequence, mode)
       VALUES ('00000000-0000-0000-0000-00000000000c', '${shipmentId}', 2, 'BOAT')`,
    ).execute(kysely)).rejects.toThrow(/check constraint/i);
    await expect(sql.raw(
      `INSERT INTO rn_stop (id, leg_id) VALUES ('00000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-0000000000ee')`,
    ).execute(kysely)).rejects.toThrow(/foreign key/i);
    await sql.raw(`DELETE FROM rn_shipment_leg`).execute(kysely);
    await sql.raw(`DELETE FROM rn_shipment`).execute(kysely);

    // DOWN restores the original model exactly.
    await applyRaw(kysely, down);
    const reDiffDown = await diff({ expected: before, actual: await introspectPostgres(kysely), dialect: "postgres" });
    expect(reDiffDown.changes.map((c) => c.kind)).toEqual([]);
  });
});
