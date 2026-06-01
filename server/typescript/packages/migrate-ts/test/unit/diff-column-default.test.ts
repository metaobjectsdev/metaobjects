/**
 * Column-default drift: the offline diff must emit `change-column-default` with
 * the right `from`/`to` payload (and omit the side that is absent), distinguish
 * an `expr` default from a `literal` default of the same text, and emit NOTHING
 * when the defaults are equal. Default drift is one of the most common real
 * migrations, so this pins the diff contract end to end.
 */
import { test, expect, describe } from "bun:test";
import { diff } from "../../src/diff/index.js";
import type { ColumnDescriptor, SchemaSnapshot } from "../../src/types.js";

function col(name: string, def?: ColumnDescriptor["default"]): ColumnDescriptor {
  return { name, sqlType: { kind: "text" }, nullable: true, ...(def !== undefined ? { default: def } : {}) };
}
function table(c: ColumnDescriptor): SchemaSnapshot {
  return { tables: [{ name: "t", columns: [c], indexes: [], foreignKeys: [], primaryKey: [], checks: [] }], views: [] };
}
function defaultChange(expected: ColumnDescriptor, actual: ColumnDescriptor) {
  return diff(table(expected), table(actual)).then((r) =>
    r.changes.find((x) => x.kind === "change-column-default"),
  );
}

describe("diff — change-column-default", () => {
  test("literal → different literal: from/to both present", async () => {
    const c = await defaultChange(col("c", { kind: "literal", value: "1" }), col("c", { kind: "literal", value: "0" }));
    expect(c).toMatchObject({
      kind: "change-column-default",
      column: "c",
      from: { kind: "literal", value: "0" },
      to: { kind: "literal", value: "1" },
    });
  });

  test("adding a default (actual has none): `to` present, `from` omitted", async () => {
    const c = await defaultChange(col("c", { kind: "literal", value: "1" }), col("c"));
    expect(c).toMatchObject({ to: { kind: "literal", value: "1" } });
    expect(c && "from" in c).toBe(false);
  });

  test("removing a default (expected has none): `from` present, `to` omitted", async () => {
    const c = await defaultChange(col("c"), col("c", { kind: "literal", value: "1" }));
    expect(c).toMatchObject({ from: { kind: "literal", value: "1" } });
    expect(c && "to" in c).toBe(false);
  });

  test("same value but different kind (expr vs literal) IS a change", async () => {
    const c = await defaultChange(col("c", { kind: "expr", value: "1" }), col("c", { kind: "literal", value: "1" }));
    expect(c).toMatchObject({
      from: { kind: "literal", value: "1" },
      to: { kind: "expr", value: "1" },
    });
  });

  test("identical defaults → NO change emitted", async () => {
    const c = await defaultChange(col("c", { kind: "literal", value: "x" }), col("c", { kind: "literal", value: "x" }));
    expect(c).toBeUndefined();
  });

  test("both sides have no default → NO change emitted", async () => {
    const c = await defaultChange(col("c"), col("c"));
    expect(c).toBeUndefined();
  });
});
