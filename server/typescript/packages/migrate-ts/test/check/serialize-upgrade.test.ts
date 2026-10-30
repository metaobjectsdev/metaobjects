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

describe("serialize with checks + snapshot format version", () => {
  // v3 added ViewDescriptor.fingerprint/dependents. An older reader that does
  // not understand them would silently fall back to comparing view TEXT against
  // Postgres's deparsed output — which never matches — and re-propose every view on
  // every migrate. So the version must be bumped, to hard-fail instead of misread.
  // v4: comments and a GENERATED identity are recorded as the database holds them.
  test("format version is 4", () => {
    expect(SNAPSHOT_FORMAT_VERSION).toBe(4);
  });

  // Before v4 a `baseline --from-db` left comments and identity out, so in a v3 file an absent
  // one says nothing; from v4 on it means none. The marker lives only in memory.
  test("a v3 snapshot reads its identity and comments as unknown; a v4 one does not, and the marker is never written", () => {
    const body = { tables: [], views: [] };
    const v3 = parseSnapshot(JSON.stringify({ formatVersion: 3, snapshot: body }));
    expect(v3.meta?.identityAndCommentsUnknown).toBe(true);
    expect(JSON.parse(serializeSnapshot(v3))).toEqual({ formatVersion: 4, snapshot: body });
    expect(parseSnapshot(JSON.stringify({ formatVersion: 4, snapshot: body })).meta).toBeUndefined();
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

  // The committed snapshot is a byte contract: `opaque` marks an `@sql` body for a live plan
  // only, and a field written to the file would owe a format-version bump.
  test("a view's opaque marker is not written", () => {
    const view = { name: "v_orders", sql: "SELECT id FROM orders", dependsOn: ["orders"] };
    const withMarker: SchemaSnapshot = { ...snap(), views: [{ ...view, opaque: true }] };
    expect(serializeSnapshot(withMarker)).toBe(serializeSnapshot({ ...snap(), views: [view] }));
    expect(withMarker.views[0]?.opaque).toBe(true);
  });

  // Releases before 1.1.0 wrote each view's guessed column types into a v3 snapshot. That
  // file must keep loading, and the retired field must not be written back.
  test("a v3 snapshot that records a view's columns still loads, without them", () => {
    const older = JSON.stringify({
      formatVersion: 3,
      snapshot: {
        tables: [],
        views: [{
          name: "v_orders", sql: "SELECT 1 AS n", fingerprint: "a".repeat(64),
          columns: [{ name: "n", sqlType: { kind: "integer", bits: 32 } }],
        }],
      },
    });
    const parsed = parseSnapshot(older);
    expect(parsed.views).toEqual([{ name: "v_orders", sql: "SELECT 1 AS n", fingerprint: "a".repeat(64) }]);
    expect(JSON.parse(serializeSnapshot(parsed))).toEqual({
      formatVersion: 4,
      snapshot: { tables: [], views: [{ name: "v_orders", sql: "SELECT 1 AS n", fingerprint: "a".repeat(64) }] },
    });
  });
});
