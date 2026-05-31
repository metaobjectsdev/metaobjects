// test/integrity/checksum.test.ts
import { describe, test, expect } from "bun:test";
import type { SchemaSnapshot } from "../../src/types.js";
import { snapshotChecksum } from "../../src/snapshot/checksum.js";

const base = (): SchemaSnapshot => ({
  tables: [{
    name: "orders",
    columns: [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false },
      { name: "ref", sqlType: { kind: "text" }, nullable: false },
    ],
    indexes: [], foreignKeys: [], checks: [], primaryKey: ["id"],
  }],
  views: [],
});

describe("snapshotChecksum", () => {
  test("is a 64-char hex sha256", () => {
    expect(snapshotChecksum(base())).toMatch(/^[0-9a-f]{64}$/);
  });
  test("is stable for the same snapshot", () => {
    expect(snapshotChecksum(base())).toBe(snapshotChecksum(base()));
  });
  test("is order-independent (shuffled columns → same hash)", () => {
    const shuffled: SchemaSnapshot = {
      ...base(),
      tables: base().tables.map((t) => ({ ...t, columns: [...t.columns].reverse() })),
    };
    expect(snapshotChecksum(shuffled)).toBe(snapshotChecksum(base()));
  });
  test("changes when the schema changes", () => {
    const changed = base();
    changed.tables[0]!.columns.push({ name: "extra", sqlType: { kind: "text" }, nullable: true });
    expect(snapshotChecksum(changed)).not.toBe(snapshotChecksum(base()));
  });
});
