/**
 * Bug gate: codegen-ts's column-mapper emits Drizzle `.array()` for EVERY scalar
 * `@isArray` field on postgres (everything except field.object / field.map), but
 * expected-schema's arrayElementSqlType mapped only string/uuid — every other
 * scalar fell through to a SCALAR column. The generated Drizzle schema and the
 * migrated DB then DISAGREED: `field.int @isArray` got an `integer` DB column
 * under an `integer("x").array()` Drizzle column, and the first insert failed
 * (`column "x" is of type integer but expression is of type integer[]`) with NO
 * drift signal (both diff sides carried the same wrong scalar).
 *
 * This pins the agreement rule: every scalar field subtype maps to
 * {kind:"array"} when @isArray on postgres; object/map stay single-jsonb.
 * Elements are UNQUALIFIED (text w/o maxLength, numeric w/o precision):
 * information_schema reports NO qualifiers for array elements (verified live on
 * PG 16 — character_maximum_length/numeric_precision are NULL for data_type
 * ARRAY), so a qualified expected element could never converge with
 * introspection (perpetual change-column-type churn — the failure mode these
 * fixes must never trade into).
 *
 * The real-engine leg (apply + INSERT ARRAY[…] + re-diff empty) lives in
 * test/integration/pg-adversarial-fixes.test.ts (MIGRATE_TS_PG_URL-gated).
 */
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import type { SqlType } from "../../src/sql-type.js";

const META = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "Sample",
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "tags", isArray: true } },
            { "field.string": { name: "codes", isArray: true, "@maxLength": 50 } },
            { "field.uuid": { name: "refIds", isArray: true } },
            { "field.int": { name: "counts", isArray: true } },
            { "field.long": { name: "bigCounts", isArray: true } },
            { "field.currency": { name: "priceHistory", isArray: true, "@currency": "USD" } },
            { "field.double": { name: "readings", isArray: true } },
            { "field.float": { name: "samples", isArray: true } },
            { "field.decimal": { name: "amounts", isArray: true, "@precision": 10, "@scale": 2 } },
            { "field.boolean": { name: "flags", isArray: true } },
            { "field.date": { name: "dates", isArray: true } },
            { "field.time": { name: "times", isArray: true } },
            { "field.timestamp": { name: "stamps", isArray: true } },
            { "field.timestamp": { name: "localStamps", isArray: true, "@localTime": true } },
            { "field.enum": { name: "labels", isArray: true, "@values": ["A", "B"] } },
            { "field.uri": { name: "links", isArray: true } },
            { "field.inet": { name: "hosts", isArray: true } },
            { "field.map": { name: "attrs", isArray: true } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

async function buildColumns(): Promise<Map<string, { sqlType: SqlType }>> {
  const root = (await new MetaDataLoader().load([new InMemoryStringSource(META)])).root;
  const snapshot = buildExpectedSchema(root, { dialect: "postgres" });
  const table = snapshot.tables.find((t) => t.name === "samples")!;
  return new Map(table.columns.map((c) => [c.name, c]));
}

describe("expected-schema — @isArray scalars agree with column-mapper's .array() rule", () => {
  test("every scalar @isArray subtype maps to a native array column", async () => {
    const cols = await buildColumns();
    const expectArray = (col: string, element: SqlType) => {
      expect(cols.get(col)?.sqlType).toEqual({ kind: "array", element });
    };
    expectArray("tags", { kind: "text" });
    // Element qualifiers are NOT representable round-trip (see header) — a
    // varchar(50) element is expected as bare text.
    expectArray("codes", { kind: "text" });
    expectArray("ref_ids", { kind: "uuid" });
    expectArray("counts", { kind: "integer", bits: 32 });
    expectArray("big_counts", { kind: "integer", bits: 64 });
    expectArray("price_history", { kind: "integer", bits: 64 });
    expectArray("readings", { kind: "real" });
    expectArray("samples", { kind: "real4" });
    expectArray("amounts", { kind: "numeric" });
    expectArray("flags", { kind: "boolean" });
    expectArray("dates", { kind: "date" });
    expectArray("times", { kind: "time" });
    expectArray("stamps", { kind: "timestamp", withTimezone: true });
    expectArray("local_stamps", { kind: "timestamp", withTimezone: false });
    expectArray("labels", { kind: "text" });
    expectArray("links", { kind: "text" });
    expectArray("hosts", { kind: "inet" });
  });

  test("field.map @isArray stays a single jsonb column (column-mapper parity)", async () => {
    const cols = await buildColumns();
    expect(cols.get("attrs")?.sqlType).toEqual({ kind: "json" });
  });

  test("an @isArray enum emits NO membership CHECK (col IN (…) is invalid SQL on text[])", async () => {
    const root = (await new MetaDataLoader().load([new InMemoryStringSource(META)])).root;
    const snapshot = buildExpectedSchema(root, { dialect: "postgres" });
    const table = snapshot.tables.find((t) => t.name === "samples")!;
    expect(table.checks.some((c) => c.name.includes("labels"))).toBe(false);
  });
});
