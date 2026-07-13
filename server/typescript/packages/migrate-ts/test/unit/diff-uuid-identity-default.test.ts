/**
 * An `identity: "uuid"` PK's physical DEFAULT is synthesized at DDL-emit time
 * (sqlite/d1: `(lower(hex(randomblob(16))))`; postgres: `gen_random_uuid()`), and
 * is deliberately NOT recorded on the expected-schema side — uuid generation is
 * modeled as `identity`, not as a `ColumnDefault`. But introspection reads that
 * DEFAULT back off the live table as a real `expr` default, so the diff saw
 * `undefined !== {kind:"expr",...}` and emitted a false-positive
 * `change-column-default` for EVERY uuid-PK table, on EVERY run.
 *
 * On SQLite/D1 that is destructive rather than merely noisy: there is no
 * ALTER COLUMN, so the engine's recreate-and-copy path rebuilds the WHOLE table
 * (CREATE __new_x / INSERT SELECT / DROP / RENAME) for every already-migrated
 * uuid-PK table on every subsequent `meta migrate` — even with zero metadata
 * changes. On Postgres it "only" emits a bogus ALTER every run.
 *
 * Identity-driven values were never meant to be diffed as ordinary defaults.
 * Reported by a downstream consumer against 0.15.20.
 */
import { test, expect, describe } from "bun:test";
import { diff } from "../../src/diff/index.js";
import type { ColumnDescriptor, SchemaSnapshot } from "../../src/types.js";

function snap(col: ColumnDescriptor): SchemaSnapshot {
  return {
    tables: [{ name: "t", columns: [col], indexes: [], foreignKeys: [], primaryKey: ["id"], checks: [] }],
    views: [],
  };
}
const expectedUuidPk: ColumnDescriptor = {
  name: "id", sqlType: { kind: "uuid" }, nullable: false, identity: "uuid",
};
function actualWith(defaultExpr: string): ColumnDescriptor {
  return { ...expectedUuidPk, default: { kind: "expr", value: defaultExpr } };
}
async function defaultChanges(expected: ColumnDescriptor, actual: ColumnDescriptor) {
  const r = await diff(snap(expected), snap(actual));
  return r.changes.filter((c) => c.kind === "change-column-default");
}

describe("diff — uuid-identity PK default is not diffed", () => {
  test("sqlite/d1 synthesized default: no change-column-default (no table rebuild)", async () => {
    const changes = await defaultChanges(expectedUuidPk, actualWith("lower(hex(randomblob(16)))"));
    expect(changes).toEqual([]);
  });

  test("postgres synthesized default: no change-column-default (no bogus ALTER every run)", async () => {
    const changes = await defaultChanges(expectedUuidPk, actualWith("gen_random_uuid()"));
    expect(changes).toEqual([]);
  });

  test("an already-migrated uuid-PK table is a total no-op (the real-world symptom)", async () => {
    const r = await diff(snap(expectedUuidPk), snap(actualWith("lower(hex(randomblob(16)))")));
    expect(r.changes).toEqual([]);
  });

  test("regression guard: increment-identity PK still no-ops (it never had a DEFAULT)", async () => {
    const inc: ColumnDescriptor = {
      name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment",
    };
    const r = await diff(snap(inc), snap(inc));
    expect(r.changes).toEqual([]);
  });

  test("regression guard: a NON-identity column still diffs its default normally", async () => {
    const expected: ColumnDescriptor = {
      name: "id", sqlType: { kind: "text" }, nullable: false, default: { kind: "literal", value: "a" },
    };
    const actual: ColumnDescriptor = {
      name: "id", sqlType: { kind: "text" }, nullable: false, default: { kind: "literal", value: "b" },
    };
    const changes = await defaultChanges(expected, actual);
    expect(changes).toHaveLength(1);
  });
});
