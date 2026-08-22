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
    checks: [],
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
      tables: [makeOrdersTable("acme_api")],
      views: [],
    };

    const result = await diff({
      expected,
      actual,
      allow: { dropTable: true },
      // Explicitly scope to BOTH schemas so this test exercises cross-schema table
      // IDENTITY (same name, different schema → distinct, not a rename). With the
      // default auto-scope the `acme_api` table would be out of the expected model's
      // declared scope ({public}) and thus left untouched — that default is covered
      // by diff-schema-scope.test.ts.
      scopeSchemas: ["public", "acme_api"],
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
    expect(drop.schema).toBe("acme_api");
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
