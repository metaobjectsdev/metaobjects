import { describe, test, expect } from "bun:test";
import { diff } from "../src/diff/index.js";
import type { SchemaSnapshot, TableDescriptor } from "../src/types.js";

// Auto schema-scoping (DiffArgs.scopeSchemas default): the diff manages only the
// schemas the EXPECTED (metadata) side declares. A table in a schema the model never
// mentions belongs to another owner (a downstream app's schema sharing the database)
// and must be left untouched — neither dropped nor reported as drift. This is what
// makes per-owner drift gates clean without manual configuration (platform model owns
// `public`; a co-located `app` schema is ignored, and vice versa).

function table(name: string, schema: string | undefined): TableDescriptor {
  const t: TableDescriptor = {
    name,
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

describe("diff — auto schema scope (manage only declared schemas)", () => {
  test("a table in an undeclared schema is left untouched (not dropped)", async () => {
    // Model declares only `public`; the live DB also has an `app`-schema table.
    const expected: SchemaSnapshot = { tables: [table("agents", "public")], views: [] };
    const actual: SchemaSnapshot = {
      tables: [table("agents", "public"), table("app_events", "app")],
      views: [],
    };

    const result = await diff({ expected, actual, allow: { dropTable: true } });

    // public.agents matches on both sides; app.app_events is OUT of the declared
    // scope ({public}) → no drop, no drift at all.
    expect(result.changes).toEqual([]);
  });

  test("a missing table WITHIN a declared schema is still real drift", async () => {
    // The scope is the declared SCHEMA set, not the declared table set — an
    // unmanaged table in a schema we DO own is still flagged.
    const expected: SchemaSnapshot = { tables: [table("agents", "public")], views: [] };
    const actual: SchemaSnapshot = {
      tables: [table("agents", "public"), table("stale", "public")],
      views: [],
    };

    const result = await diff({ expected, actual, allow: { dropTable: true } });

    const drops = result.changes.filter((c) => c.kind === "drop-table");
    expect(drops).toHaveLength(1);
    if (drops[0]?.kind !== "drop-table") throw new Error("expected a drop-table");
    expect(drops[0].table).toBe("stale");
    expect(drops[0].schema).toBe("public");
  });

  test("an explicit scopeSchemas overrides the auto-derived set", async () => {
    // Force-manage `app` even though the model also declares public: the app table
    // present in the DB but absent from the model is dropped; the public table (now
    // out of the explicit scope) is ignored.
    const expected: SchemaSnapshot = {
      tables: [table("agents", "public"), table("app_events", "app")],
      views: [],
    };
    const actual: SchemaSnapshot = {
      tables: [table("orphan", "app"), table("untouched", "public")],
      views: [],
    };

    const result = await diff({
      expected,
      actual,
      allow: { dropTable: true },
      scopeSchemas: ["app"],
    });

    const kinds = result.changes.map((c) => c.kind).sort();
    // app.app_events created, app.orphan dropped; nothing in public touched.
    expect(kinds).toEqual(["create-table", "drop-table"]);
    expect(result.changes.every((c) => c.schema === "app" || c.kind === "create-table")).toBe(true);
    const drop = result.changes.find((c) => c.kind === "drop-table");
    if (drop?.kind !== "drop-table") throw new Error("expected a drop-table");
    expect(drop.schema).toBe("app");
    expect(drop.table).toBe("orphan");
  });

  test("empty expected model → no scoping (prior whole-DB behavior preserved)", async () => {
    // Nothing declared → scope is null → the DB's tables are still seen (here, as
    // drops). Guards against an empty model silently ignoring an entire database.
    const expected: SchemaSnapshot = { tables: [], views: [] };
    const actual: SchemaSnapshot = { tables: [table("leftover", "public")], views: [] };

    const result = await diff({ expected, actual, allow: { dropTable: true } });

    const drops = result.changes.filter((c) => c.kind === "drop-table");
    expect(drops).toHaveLength(1);
  });
});
