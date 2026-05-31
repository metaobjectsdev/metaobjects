// test/check/serialize-upgrade.test.ts
import { describe, test, expect } from "bun:test";
import type { SchemaSnapshot } from "../../src/types.js";
import { serializeSnapshot, parseSnapshot, SNAPSHOT_FORMAT_VERSION } from "../../src/snapshot/serialize.js";

const snap = (): SchemaSnapshot => ({
  tables: [{
    name: "orders", columns: [], indexes: [], foreignKeys: [], primaryKey: [],
    checks: [{ name: "orders_status_chk", expression: "status IN ('OPEN','CLOSED')" }],
  }],
  views: [],
});

describe("serialize with checks + formatVersion 2", () => {
  test("format version is 2", () => {
    expect(SNAPSHOT_FORMAT_VERSION).toBe(2);
  });

  test("checks round-trip and are order-stable", () => {
    const s = snap();
    expect(serializeSnapshot(parseSnapshot(serializeSnapshot(s)))).toBe(serializeSnapshot(s));
    expect(parseSnapshot(serializeSnapshot(s)).tables[0]?.checks[0]?.name).toBe("orders_status_chk");
  });

  test("a v1 snapshot (no checks) upgrades to tables with empty checks[]", () => {
    const v1 = JSON.stringify({
      formatVersion: 1,
      snapshot: { tables: [{ name: "orders", columns: [], indexes: [], foreignKeys: [], primaryKey: [] }], views: [] },
    });
    const parsed = parseSnapshot(v1);
    expect(parsed.tables[0]?.checks).toEqual([]);
  });
});
