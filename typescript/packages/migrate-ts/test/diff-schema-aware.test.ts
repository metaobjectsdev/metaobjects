import { describe, test, expect } from "bun:test";
import { diff } from "../src/diff/index.js";
import type { SchemaSnapshot, TableDescriptor } from "../src/types.js";

/**
 * Two ordinary single-column tables with the same name, differing only by schema.
 * Built by hand (no metadata needed) so the test exercises diff() directly.
 */
function makeOrdersTable(schema: string | undefined): TableDescriptor {
  const t: TableDescriptor = {
    name: "orders",
    columns: [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
    ],
    indexes: [],
    foreignKeys: [],
    primaryKey: ["id"],
  };
  if (schema !== undefined) t.schema = schema;
  return t;
}

describe("diff — schema-aware table identity", () => {
  test("treats tables with same name in different schemas as distinct", async () => {
    const expected: SchemaSnapshot = {
      tables: [makeOrdersTable("public")],
      views: [],
    };
    const actual: SchemaSnapshot = {
      tables: [makeOrdersTable("p3_api")],
      views: [],
    };

    const result = await diff({
      expected,
      actual,
      allow: { dropTable: true },
    });

    const kinds = result.changes.map((c) => c.kind).sort();
    // Should NOT be a rename — schemas differ. Should be a create + a drop.
    expect(kinds).toEqual(["create-table", "drop-table"]);

    const create = result.changes.find((c) => c.kind === "create-table");
    const drop = result.changes.find((c) => c.kind === "drop-table");

    if (create?.kind !== "create-table") throw new Error("expected a create-table change");
    expect(create.table.name).toBe("orders");
    expect(create.table.schema).toBe("public");

    if (drop?.kind !== "drop-table") throw new Error("expected a drop-table change");
    expect(drop.table).toBe("orders");
    expect(drop.schema).toBe("p3_api");
  });

  test("treats schema=undefined and schema='public' as equivalent for Postgres", async () => {
    const expected: SchemaSnapshot = {
      tables: [makeOrdersTable(undefined)],
      views: [],
    };
    const actual: SchemaSnapshot = {
      tables: [makeOrdersTable("public")],
      views: [],
    };

    const result = await diff({ expected, actual });
    expect(result.changes).toEqual([]);
  });
});
