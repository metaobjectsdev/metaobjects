import { test, expect, describe } from "bun:test";
import { buildFkEdges, unionEdges, affectedSet, topoOrder } from "../../src/emit/fk-graph.js";
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

describe("buildFkEdges", () => {
  test("maps a child table to its parent (referenced) table", () => {
    const schema: SchemaSnapshot = {
      tables: [table("p"), table("c", ["p"])],
      views: [],
    };
    const edges = buildFkEdges(schema);
    expect(edges.get("c")).toEqual(new Set(["p"]));
    expect(edges.get("p")).toEqual(new Set());
  });

  test("a self-referential table maps to itself", () => {
    const schema: SchemaSnapshot = { tables: [table("node", ["node"])], views: [] };
    const edges = buildFkEdges(schema);
    expect(edges.get("node")).toEqual(new Set(["node"]));
  });
});

describe("unionEdges", () => {
  test("merges two edge maps without mutating the inputs", () => {
    const a = new Map([["c", new Set(["p"])]]);
    const b = new Map([["c", new Set(["q"])], ["r", new Set(["s"])]]);
    const merged = unionEdges(a, b);
    expect(merged.get("c")).toEqual(new Set(["p", "q"]));
    expect(merged.get("r")).toEqual(new Set(["s"]));
    // inputs unchanged
    expect(a.get("c")).toEqual(new Set(["p"]));
    expect(b.get("c")).toEqual(new Set(["q"]));
  });
});

describe("affectedSet", () => {
  test("pulls in a transitive referrer (grandchild) via g→c→p", () => {
    const schema: SchemaSnapshot = {
      tables: [table("p"), table("c", ["p"]), table("g", ["c"])],
      views: [],
    };
    const edges = buildFkEdges(schema);
    const affected = affectedSet(new Set(["p"]), edges);
    expect(affected).toEqual(new Set(["p", "c", "g"]));
  });

  test("returns just the recreated set when nothing references it", () => {
    const schema: SchemaSnapshot = { tables: [table("solo")], views: [] };
    const edges = buildFkEdges(schema);
    expect(affectedSet(new Set(["solo"]), edges)).toEqual(new Set(["solo"]));
  });
});

describe("topoOrder", () => {
  test("returns parents-first for g→c→p", () => {
    const schema: SchemaSnapshot = {
      tables: [table("p"), table("c", ["p"]), table("g", ["c"])],
      views: [],
    };
    const edges = buildFkEdges(schema);
    const nodes = new Set(["p", "c", "g"]);
    const result = topoOrder(nodes, edges);
    expect(result.cycle).toBeNull();
    expect(result.order).toEqual(["p", "c", "g"]);
  });

  test("self-loops don't block the sort", () => {
    const schema: SchemaSnapshot = {
      tables: [table("p"), table("c", ["p", "c"])],
      views: [],
    };
    const edges = buildFkEdges(schema);
    const nodes = new Set(["p", "c"]);
    const result = topoOrder(nodes, edges);
    expect(result.cycle).toBeNull();
    expect(result.order).toEqual(["p", "c"]);
  });

  test("a two-node cycle (A↔B) is reported and cannot be ordered", () => {
    const schema: SchemaSnapshot = {
      tables: [table("A", ["B"]), table("B", ["A"])],
      views: [],
    };
    const edges = buildFkEdges(schema);
    const nodes = new Set(["A", "B"]);
    const result = topoOrder(nodes, edges);
    expect(result.order).toEqual([]);
    expect(result.cycle).toEqual(["A", "B"]);
  });
});
