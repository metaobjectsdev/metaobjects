import { test, expect, describe } from "bun:test";
import {
  findReferencedRebuilds,
  D1ReferencedTableRebuildError,
} from "../../src/emit/d1-fk-refuse.js";
import type { SchemaSnapshot, TableDescriptor } from "../../src/types.js";

function table(name: string, refTables: string[] = []): TableDescriptor {
  return {
    name,
    columns: [{ name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false }],
    indexes: [],
    foreignKeys: refTables.map((rt, i) => ({
      name: `${name}_fk${i}`,
      columns: ["ref_id"],
      refTable: rt,
      refColumns: ["id"],
    })),
    checks: [],
    primaryKey: ["id"],
  };
}

describe("findReferencedRebuilds", () => {
  test("returns a refusal when a rebuilt table is referenced by another table", () => {
    const schema: SchemaSnapshot = {
      tables: [table("parent"), table("child", ["parent"])],
      views: [],
    };
    const refusals = findReferencedRebuilds(new Set(["parent"]), schema);
    expect(refusals).toEqual([{ table: "parent", referencedBy: ["child"] }]);
  });

  test("returns a refusal for a self-referential table (references itself)", () => {
    const schema: SchemaSnapshot = { tables: [table("node", ["node"])], views: [] };
    const refusals = findReferencedRebuilds(new Set(["node"]), schema);
    expect(refusals).toEqual([{ table: "node", referencedBy: ["node"] }]);
  });

  test("returns empty when the rebuilt table is not referenced by anything", () => {
    const schema: SchemaSnapshot = {
      tables: [table("logs"), table("child", ["parent"]), table("parent")],
      views: [],
    };
    expect(findReferencedRebuilds(new Set(["logs"]), schema)).toEqual([]);
  });

  test("only reports rebuilt tables, not every referenced table", () => {
    const schema: SchemaSnapshot = {
      tables: [table("parent"), table("child", ["parent"])],
      views: [],
    };
    // "child" is rebuilt but nothing references "child" → no refusal.
    expect(findReferencedRebuilds(new Set(["child"]), schema)).toEqual([]);
  });
});

describe("D1ReferencedTableRebuildError", () => {
  test("message names the table, its referencer, and the workaround", () => {
    const err = new D1ReferencedTableRebuildError([
      { table: "parent", referencedBy: ["child"] },
    ]);
    expect(err.name).toBe("D1ReferencedTableRebuildError");
    expect(err.message).toContain('"parent"');
    expect(err.message).toContain('"child"');
    expect(err.message).toContain("foreign key");
    expect(err.message.toLowerCase()).toContain("hand-write");
    expect(err.refusals).toHaveLength(1);
  });
});
