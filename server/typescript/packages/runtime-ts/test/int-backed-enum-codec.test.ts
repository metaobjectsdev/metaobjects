import { describe, test, expect } from "bun:test";
import type { MetaData } from "@metaobjectsdev/metadata";
import { TypeId, TYPE_OBJECT, TYPE_FIELD, TYPE_IDENTITY,
         FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_ENUM,
         FIELD_ATTR_VALUES, FIELD_ATTR_INT_VALUE_MAP,
         IDENTITY_SUBTYPE_PRIMARY, OBJECT_SUBTYPE_ENTITY } from "@metaobjectsdev/metadata";
import { meta } from "./_meta-build.js";
import { coerceRowOnRead, coerceRowOnWrite } from "../src/type-coercer.js";
import { compileFilter } from "../src/query-builder.js";

// An int-backed field.enum (@intValueMap) persists as an INTEGER while the runtime's
// value — in, out, and in a filter — stays the member SYMBOL. This is the ObjectManager
// half of the codec: the generated Drizzle `customType` covers the codegen path, and
// nothing covered this one, so `create()` bound "PUBLISHED" straight into an integer
// column and Postgres rejected the statement.

const VALUES = ["DRAFT", "PUBLISHED", "ARCHIVED"];
const INT_MAP = { DRAFT: 0, PUBLISHED: 5, ARCHIVED: 9 };

/**
 * An Order whose `status` is int-backed, plus a string-backed `kind` for contrast.
 * Takes `null` — not `undefined` — for "no map": passing `undefined` explicitly would
 * trigger the default parameter and silently hand back the int-backed shape, which is
 * exactly how the first draft of the string-backed test passed for the wrong reason.
 */
function makeOrder(intMap: Record<string, number> | null = INT_MAP): MetaData {
  const order = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Order");
  order.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id"));

  const status = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_ENUM), "status");
  status.setAttr(FIELD_ATTR_VALUES, VALUES);
  if (intMap !== null) status.setAttr(FIELD_ATTR_INT_VALUE_MAP, intMap);
  order.addChild(status);

  const kind = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_ENUM), "kind");
  kind.setAttr(FIELD_ATTR_VALUES, VALUES);
  order.addChild(kind);

  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  order.addChild(primary);
  return order;
}

describe("int-backed field.enum — ObjectManager write codec", () => {
  test("encodes the member symbol to its declared int", () => {
    const row = coerceRowOnWrite(makeOrder(), { id: 1, status: "PUBLISHED" }, "postgres");
    expect(row.status).toBe(5);
  });

  test("a string-backed enum on the same entity is untouched", () => {
    const row = coerceRowOnWrite(makeOrder(), { id: 1, kind: "PUBLISHED" }, "postgres");
    expect(row.kind).toBe("PUBLISHED");
  });

  test("encodes on sqlite too — the column is INTEGER on every dialect", () => {
    const row = coerceRowOnWrite(makeOrder(), { id: 1, status: "ARCHIVED" }, "sqlite");
    expect(row.status).toBe(9);
  });

  test("null passes through", () => {
    const row = coerceRowOnWrite(makeOrder(), { id: 1, status: null }, "postgres");
    expect(row.status).toBeNull();
  });

  // Membership is the column's CHECK to enforce; inventing a value here would hide drift.
  test("an unmapped symbol is passed through for the database to reject", () => {
    const row = coerceRowOnWrite(makeOrder(), { id: 1, status: "NOPE" }, "postgres");
    expect(row.status).toBe("NOPE");
  });

  test("a field absent from the row stays absent", () => {
    const row = coerceRowOnWrite(makeOrder(), { id: 1 }, "postgres");
    expect("status" in row).toBe(false);
  });
});

describe("int-backed field.enum — ObjectManager read codec", () => {
  test("decodes the stored int back to the member symbol", () => {
    const row = coerceRowOnRead(makeOrder(), { id: 1, status: 5 }, "postgres");
    expect(row.status).toBe("PUBLISHED");
  });

  test("decodes 0 — the falsy member the naive guard drops", () => {
    const row = coerceRowOnRead(makeOrder(), { id: 1, status: 0 }, "postgres");
    expect(row.status).toBe("DRAFT");
  });

  test("a driver-stringified integer still decodes", () => {
    const row = coerceRowOnRead(makeOrder(), { id: 1, status: "9" }, "postgres");
    expect(row.status).toBe("ARCHIVED");
  });

  test("null stays null", () => {
    const row = coerceRowOnRead(makeOrder(), { id: 1, status: null }, "postgres");
    expect(row.status).toBeNull();
  });

  test("a string-backed enum reads through unchanged", () => {
    const row = coerceRowOnRead(makeOrder(), { id: 1, kind: "DRAFT" }, "postgres");
    expect(row.kind).toBe("DRAFT");
  });

  // The row holds data the model says is impossible. Surfacing the raw int would hand
  // the caller a "member" that is not one; null would hide the corruption. Every port throws.
  test("a stored int with no member THROWS", () => {
    expect(() => coerceRowOnRead(makeOrder(), { id: 1, status: 7 }, "postgres")).toThrow(
      /stored value 7 with no member in @intValueMap/,
    );
  });

  test("an enum with no @intValueMap is left alone entirely", () => {
    const row = coerceRowOnRead(makeOrder(null), { id: 1, status: 5 }, "postgres");
    expect(row.status).toBe(5);
  });
});

describe("int-backed field.enum — filter values", () => {
  test("eq encodes the symbol", () => {
    expect(compileFilter(makeOrder(), { status: "PUBLISHED" })).toEqual({
      kind: "eq", column: "status", value: 5,
    });
  });

  test("$ne encodes", () => {
    expect(compileFilter(makeOrder(), { status: { $ne: "DRAFT" } })).toEqual({
      kind: "ne", column: "status", value: 0,
    });
  });

  test("$in encodes every member", () => {
    expect(compileFilter(makeOrder(), { status: { $in: ["DRAFT", "ARCHIVED"] } })).toEqual({
      kind: "in", column: "status", values: [0, 9],
    });
  });

  test("a bare array encodes every member", () => {
    expect(compileFilter(makeOrder(), { status: ["PUBLISHED"] })).toEqual({
      kind: "in", column: "status", values: [5],
    });
  });

  test("a string-backed enum filter is untouched", () => {
    expect(compileFilter(makeOrder(), { kind: "PUBLISHED" })).toEqual({
      kind: "eq", column: "kind", value: "PUBLISHED",
    });
  });

  // A filter naming a member that does not exist should match nothing, not throw —
  // and it must not silently become a WRONG integer.
  test("an unmapped symbol passes through rather than becoming a wrong int", () => {
    expect(compileFilter(makeOrder(), { status: "NOPE" })).toEqual({
      kind: "eq", column: "status", value: "NOPE",
    });
  });

  test("isNull carries no value to encode", () => {
    expect(compileFilter(makeOrder(), { status: null })).toEqual({
      kind: "isNull", column: "status", not: false,
    });
  });
});
