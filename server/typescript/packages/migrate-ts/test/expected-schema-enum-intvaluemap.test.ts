import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";
import { diff } from "../src/diff/index.js";

// Int-backed field.enum (@intValueMap, design D5): the column is `integer`, not
// `text`. The wire/TS type is unchanged — only the physical column differs.

async function loadJson(json: string): Promise<MetaData> {
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) {
    throw new Error(`fixture failed to load: ${result.errors.map((e) => String(e)).join("; ")}`);
  }
  return result.root;
}

function entityModel(statusField: Record<string, unknown>, extraRoots: unknown[] = []): string {
  return JSON.stringify({
    "metadata.root": {
      children: [
        ...extraRoots,
        {
          "object.entity": {
            name: "Order",
            children: [
              { "field.long": { name: "id" } },
              { "field.enum": statusField },
              { "source.rdb": { name: "src", "@table": "orders" } },
              { "identity.primary": { name: "pk", "@fields": ["id"] } },
            ],
          },
        },
      ],
    },
  });
}

const VALUES = ["DRAFT", "PUBLISHED", "ARCHIVED"];
const INT_MAP = { DRAFT: 0, PUBLISHED: 5, ARCHIVED: 9 };

async function statusColumn(json: string) {
  const snapshot = buildExpectedSchema(await loadJson(json));
  const table = snapshot.tables.find((t) => t.name === "orders")!;
  return table.columns.find((c) => c.name === "status")!;
}

describe("buildExpectedSchema — int-backed field.enum (@intValueMap)", () => {
  test("scalar int-backed enum maps to integer, not text", async () => {
    const col = await statusColumn(
      entityModel({ name: "status", "@values": VALUES, "@intValueMap": INT_MAP }),
    );
    expect(col.sqlType).toEqual({ kind: "integer", bits: 32 });
  });

  test("string-backed enum (no @intValueMap) is unchanged", async () => {
    const col = await statusColumn(entityModel({ name: "status", "@values": VALUES }));
    expect(col.sqlType).toEqual({ kind: "text" });
  });

  // D7, narrowed: int-backing is scalar-only — @intValueMap with isArray is
  // ERR_ENUM_INT_VALUE_MAP_ARRAY at LOAD, so no int-backed array column shape exists
  // to assert. The rejection is gated by the loader tests + the cross-port
  // error-enum-intvaluemap-array fixtures.
  test("array-of-enum string-backed stays text[]", async () => {
    const col = await statusColumn(entityModel({ name: "status", isArray: true, "@values": VALUES }));
    expect(col.sqlType).toEqual({ kind: "array", element: { kind: "text" } });
  });

  // Amendment 1 / #246: post-#246 the map CANNOT live on the consuming field when
  // the field extends a shared (root-level abstract) enum — it lives on the SHARED
  // DECLARATION and is inherited. An own-only read here would see undefined and
  // silently emit a text column for an integer-encoded value. This is the shape
  // real adopters will author, so it is the one that most needs pinning.
  test("map inherited from a SHARED abstract declaration still yields integer", async () => {
    const col = await statusColumn(
      entityModel({ name: "status", extends: "Status" }, [
        { "field.enum": { name: "Status", abstract: true, "@values": VALUES, "@intValueMap": INT_MAP } },
      ]),
    );
    expect(col.sqlType).toEqual({ kind: "integer", bits: 32 });
  });

  test("the membership CHECK lists the mapped INTEGERS, unquoted", async () => {
    const snapshot = buildExpectedSchema(
      await loadJson(entityModel({ name: "status", "@values": VALUES, "@intValueMap": INT_MAP })),
    );
    const table = snapshot.tables.find((t) => t.name === "orders")!;
    const chk = table.checks!.find((c) => c.name === "orders_status_chk")!;
    expect(chk.expression).toBe(`"status" IN (0, 5, 9)`);
  });

  test("string-backed enum keeps its quoted-string CHECK", async () => {
    const snapshot = buildExpectedSchema(
      await loadJson(entityModel({ name: "status", "@values": VALUES })),
    );
    const table = snapshot.tables.find((t) => t.name === "orders")!;
    const chk = table.checks!.find((c) => c.name === "orders_status_chk")!;
    expect(chk.expression).toBe(`"status" IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')`);
  });

  test("an int-backed enum inheriting its map from a shared decl gets the integer CHECK", async () => {
    const snapshot = buildExpectedSchema(
      await loadJson(
        entityModel({ name: "status", extends: "Status" }, [
          { "field.enum": { name: "Status", abstract: true, "@values": VALUES, "@intValueMap": INT_MAP } },
        ]),
      ),
    );
    const table = snapshot.tables.find((t) => t.name === "orders")!;
    const chk = table.checks!.find((c) => c.name === "orders_status_chk")!;
    expect(chk.expression).toBe(`"status" IN (0, 5, 9)`);
  });

  test("array-of-enum still gets NO field-level CHECK (membership stays app-level)", async () => {
    const snapshot = buildExpectedSchema(
      await loadJson(entityModel({ name: "status", isArray: true, "@values": VALUES })),
    );
    const table = snapshot.tables.find((t) => t.name === "orders")!;
    expect((table.checks ?? []).find((c) => c.name === "orders_status_chk")).toBeUndefined();
  });

  // Task 7 — @default names a MEMBER, the column holds the mapped INT. Emitting
  // DEFAULT 'DRAFT' on an integer column is un-appliable DDL.
  test("@default lowers to the mapped integer literal", async () => {
    const col = await statusColumn(
      entityModel({ name: "status", "@values": VALUES, "@intValueMap": INT_MAP, "@default": "PUBLISHED" }),
    );
    expect(col.default).toEqual({ kind: "literal", value: "5" });
  });

  test("@default on a string-backed enum is unchanged", async () => {
    const col = await statusColumn(
      entityModel({ name: "status", "@values": VALUES, "@default": "PUBLISHED" }),
    );
    expect(col.default).toEqual({ kind: "literal", value: "PUBLISHED" });
  });

  test("a zero-valued member default survives (0 is falsy — must not be dropped)", async () => {
    const col = await statusColumn(
      entityModel({ name: "status", "@values": VALUES, "@intValueMap": INT_MAP, "@default": "DRAFT" }),
    );
    expect(col.default).toEqual({ kind: "literal", value: "0" });
  });

  // Array-ness inherited from a shared declaration still resolves here. This
  // replaced a test that inherited array-ness AND @intValueMap together, which is
  // now ERR_ENUM_INT_VALUE_MAP_ARRAY at load (D7, narrowed) — that rejection is
  // gated by the loader tests and the error-enum-intvaluemap-array-inherited
  // fixture. What remains worth pinning at THIS layer is the resolving read of
  // array-ness itself, since an own-only read would emit a scalar column.
  test("array-ness inherited from the shared declaration still yields an array column", async () => {
    const col = await statusColumn(
      entityModel({ name: "status", extends: "Status" }, [
        { "field.enum": { name: "Status", abstract: true, isArray: true, "@values": VALUES } },
      ]),
    );
    expect(col.sqlType).toEqual({ kind: "array", element: { kind: "text" } });
  });
});

// Task 3 — the D8 migration-safety guard needs NO new gating code. Toggling
// @intValueMap on a field that already has a column is a text<->integer
// change-column-type, and `isWidening` returns false for ANY cross-kind pair
// (sql-type.ts: `if (from.kind !== to.kind) return false`), so
// `blockedReasonFor`'s change-column-type branch blocks it unless allow.typeChange
// is passed. This proves that end-to-end through the real metadata path rather
// than asserting it about hand-built snapshots.
describe("int-backed enum — backing-mode change is blocked by the existing guard", () => {
  const STRING_BACKED = entityModel({ name: "status", "@values": VALUES });
  const INT_BACKED = entityModel({ name: "status", "@values": VALUES, "@intValueMap": INT_MAP });

  async function backingModeDiff(expected: string, actual: string, allowTypeChange = false) {
    const e = buildExpectedSchema(await loadJson(expected));
    const a = buildExpectedSchema(await loadJson(actual));
    return diff(e, a, allowTypeChange ? { allow: { typeChange: true } } : undefined);
  }

  test("ADDING @intValueMap (text → integer) is blocked without allow.typeChange", async () => {
    const r = await backingModeDiff(INT_BACKED, STRING_BACKED);
    const change = r.changes.find((c) => c.kind === "change-column-type");
    expect(change).toBeDefined();
    expect(change!.status.state).toBe("blocked");
    expect(r.blocked).toContain(change!);
  });

  test("REMOVING @intValueMap (integer → text) is blocked too", async () => {
    const r = await backingModeDiff(STRING_BACKED, INT_BACKED);
    const change = r.changes.find((c) => c.kind === "change-column-type");
    expect(change).toBeDefined();
    expect(change!.status.state).toBe("blocked");
  });

  test("an explicit allow.typeChange unblocks it (the documented manual-recast path)", async () => {
    const r = await backingModeDiff(INT_BACKED, STRING_BACKED, true);
    const change = r.changes.find((c) => c.kind === "change-column-type");
    expect(change!.status.state).toBe("allowed");
    expect(r.blocked).toHaveLength(0);
  });

  test("no backing-mode change → no change-column-type at all", async () => {
    const r = await backingModeDiff(INT_BACKED, INT_BACKED);
    expect(r.changes.find((c) => c.kind === "change-column-type")).toBeUndefined();
  });
});
