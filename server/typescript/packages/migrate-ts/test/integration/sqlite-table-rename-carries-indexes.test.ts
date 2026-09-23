/**
 * SQLite counterpart of pg-table-rename-carries-constraints: `ALTER TABLE … RENAME TO`
 * carries the table's indexes on SQLite too, so a resolved table rename must not re-create
 * them (the replay died on `index … already exists`), and every change on the renamed
 * table must run after the rename. Real engine: apply, re-introspect, re-diff MUST be empty.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspectSqlite } from "../../src/introspect/sqlite.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";
import type { SchemaSnapshot } from "../../src/types.js";

function model(legTable: string, extraField: boolean): string {
  return JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [
        {
          "object.entity": {
            name: "Leg",
            children: [
              { "source.rdb": { "@table": legTable } },
              { "field.long": { name: "id" } },
              { "field.long": { name: "shipmentId", "@column": "shipment_id", "@required": true } },
              { "field.int": { name: "sequence", "@required": true } },
              { "field.enum": { name: "mode", "@required": true, "@values": ["TRUCK", "RAIL"] } },
              ...(extraField ? [{ "field.string": { name: "note" } }] : []),
              { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
              { "identity.secondary": { name: "uqLegShipmentSeq", "@fields": ["shipmentId", "sequence"] } },
              { "index.lookup": { name: "idxLegSequence", "@fields": ["sequence"] } },
            ],
          },
        },
      ],
    },
  });
}

let tmpDir: string;
let k: Kysely<Record<string, unknown>>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "migrate-ts-table-rename-"));
  k = new Kysely({ dialect: new LibsqlDialect({ url: `file:${join(tmpDir, "t.db")}` }) });
});
afterEach(async () => {
  await k.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function expectedFor(legTable: string, extraField: boolean): Promise<SchemaSnapshot> {
  const loaded = await new MetaDataLoader().load([new InMemoryStringSource(model(legTable, extraField))]);
  expect(loaded.errors).toEqual([]);
  return buildExpectedSchema(loaded.root, { dialect: "sqlite" });
}

async function migrate(expected: SchemaSnapshot): Promise<string> {
  const actual = await introspectSqlite(k);
  const d = await diff({ expected, actual, dialect: "sqlite", onAmbiguous: async () => "rename" });
  const { up } = emit(d.changes, {
    dialect: "sqlite",
    expectedSchema: expected,
    ...(actual.meta !== undefined && { actualMeta: actual.meta }),
  });
  for (const stmt of up.trim().split(";").map((s) => s.trim()).filter(Boolean)) {
    await sql.raw(stmt).execute(k);
  }
  return up;
}

describe("a table rename carries its indexes (SQLite)", () => {
  test("REGRESSION: the rename applies, adds a column to the renamed table, and converges", async () => {
    await migrate(await expectedFor("leg", false));

    const after = await expectedFor("shipment_leg", true);
    const up = await migrate(after);
    expect(up).toContain(`ALTER TABLE "leg" RENAME TO "shipment_leg";`);
    expect(up).not.toMatch(/CREATE (UNIQUE )?INDEX/);
    // The column add targets the NEW name, so it must follow the rename.
    expect(up.indexOf("RENAME TO")).toBeLessThan(up.indexOf("ADD COLUMN"));

    const reDiff = await diff({ expected: after, actual: await introspectSqlite(k), dialect: "sqlite" });
    expect(reDiff.changes.map((c) => c.kind)).toEqual([]);
  });
});
