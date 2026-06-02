import { test, expect, describe } from "bun:test";
import { diff } from "../../src/diff/index.js";
import type { SchemaSnapshot, AmbiguousChange } from "../../src/types.js";

function snap(): SchemaSnapshot { return { tables: [], views: [] }; }

function tableWithCols(cols: { name: string; type?: "text" | "integer"; nullable?: boolean }[]) {
  return {
    name: "u",
    columns: cols.map((c) => ({
      name: c.name,
      sqlType: c.type === "integer" ? { kind: "integer" as const, bits: 64 as const } : { kind: "text" as const },
      nullable: c.nullable ?? true,
    })),
    indexes: [],
    foreignKeys: [],
    primaryKey: [],
    checks: [],
  };
}

describe("rename-heuristic — column", () => {
  test("close-name same-type pair triggers callback", async () => {
    const expected: SchemaSnapshot = { tables: [tableWithCols([{ name: "first_name" }])], views: [] };
    const actual: SchemaSnapshot = { tables: [tableWithCols([{ name: "firstname" }])], views: [] };
    const calls: AmbiguousChange[] = [];
    const r = await diff({
      expected, actual,
      onAmbiguous: async (q) => { calls.push(q); return "rename"; },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("possible-column-rename");
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ kind: "rename-column", from: "firstname", to: "first_name" });
  });

  test("callback returning 'drop+add' keeps both changes", async () => {
    const expected: SchemaSnapshot = { tables: [tableWithCols([{ name: "first_name" }])], views: [] };
    const actual: SchemaSnapshot = { tables: [tableWithCols([{ name: "firstname" }])], views: [] };
    const r = await diff({
      expected, actual, allow: { dropColumn: true },
      onAmbiguous: async () => "drop+add",
    });
    expect(r.changes.find((c) => c.kind === "drop-column")).toBeDefined();
    expect(r.changes.find((c) => c.kind === "add-column")).toBeDefined();
    expect(r.changes.find((c) => c.kind === "rename-column")).toBeUndefined();
  });

  test("callback returning 'abort' throws", async () => {
    const expected: SchemaSnapshot = { tables: [tableWithCols([{ name: "first_name" }])], views: [] };
    const actual: SchemaSnapshot = { tables: [tableWithCols([{ name: "firstname" }])], views: [] };
    await expect(diff({
      expected, actual,
      onAmbiguous: async () => "abort",
    })).rejects.toThrow();
  });

  test("no callback → defaults to drop+add (safer)", async () => {
    const expected: SchemaSnapshot = { tables: [tableWithCols([{ name: "first_name" }])], views: [] };
    const actual: SchemaSnapshot = { tables: [tableWithCols([{ name: "firstname" }])], views: [] };
    const r = await diff({ expected, actual, allow: { dropColumn: true } });
    expect(r.changes.find((c) => c.kind === "rename-column")).toBeUndefined();
    expect(r.changes.find((c) => c.kind === "drop-column")).toBeDefined();
  });

  test("different SqlType → NOT a rename candidate (no callback fired)", async () => {
    const expected: SchemaSnapshot = { tables: [tableWithCols([{ name: "first_name", type: "integer" }])], views: [] };
    const actual: SchemaSnapshot = { tables: [tableWithCols([{ name: "firstname", type: "text" }])], views: [] };
    const calls: AmbiguousChange[] = [];
    await diff({ expected, actual, allow: { dropColumn: true }, onAmbiguous: async (q) => { calls.push(q); return "rename"; } });
    expect(calls).toHaveLength(0);
  });

  test("name distance over threshold → NOT a candidate", async () => {
    // "email" → "email_address" — distance 8, threshold for min-len 5 = max(2, floor(5/3)) = 2 → fails
    const expected: SchemaSnapshot = { tables: [tableWithCols([{ name: "email_address" }])], views: [] };
    const actual: SchemaSnapshot = { tables: [tableWithCols([{ name: "email" }])], views: [] };
    const calls: AmbiguousChange[] = [];
    await diff({ expected, actual, allow: { dropColumn: true }, onAmbiguous: async (q) => { calls.push(q); return "rename"; } });
    expect(calls).toHaveLength(0);
  });

  test("rename-column passes status check (not blocked)", async () => {
    const expected: SchemaSnapshot = { tables: [tableWithCols([{ name: "first_name" }])], views: [] };
    const actual: SchemaSnapshot = { tables: [tableWithCols([{ name: "firstname" }])], views: [] };
    const r = await diff({ expected, actual, onAmbiguous: async () => "rename" });
    expect(r.blocked).toEqual([]);
  });
});

describe("rename-heuristic — table", () => {
  function table(name: string) {
    return {
      name,
      columns: [
        { name: "id", sqlType: { kind: "integer" as const, bits: 64 as const }, nullable: false },
        { name: "title", sqlType: { kind: "text" as const }, nullable: false },
        { name: "created_at", sqlType: { kind: "timestamp" as const, withTimezone: false }, nullable: true },
      ],
      indexes: [],
      foreignKeys: [],
      primaryKey: ["id"],
      checks: [],
    };
  }

  test("dropped + created tables with identical columns trigger callback", async () => {
    const expected = { tables: [table("articles")], views: [] };
    const actual = { tables: [table("posts")], views: [] };
    const calls: AmbiguousChange[] = [];
    const r = await diff({
      expected, actual,
      onAmbiguous: async (q) => { calls.push(q); return "rename"; },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("possible-table-rename");
    expect(r.changes.find((c) => c.kind === "rename-table")).toMatchObject({
      from: "posts", to: "articles",
    });
    expect(r.changes.find((c) => c.kind === "create-table")).toBeUndefined();
    expect(r.changes.find((c) => c.kind === "drop-table")).toBeUndefined();
  });

  test("low column overlap → NOT a candidate (no callback)", async () => {
    const expected = { tables: [table("articles")], views: [] };
    const actual = {
      tables: [{
        name: "completely_different",
        columns: [
          { name: "x", sqlType: { kind: "integer" as const, bits: 32 as const }, nullable: true },
          { name: "y", sqlType: { kind: "real" as const }, nullable: true },
        ],
        indexes: [], foreignKeys: [], primaryKey: [], checks: [],
      }],
      views: [],
    };
    const calls: AmbiguousChange[] = [];
    await diff({
      expected, actual, allow: { dropTable: true },
      onAmbiguous: async (q) => { calls.push(q); return "rename"; },
    });
    expect(calls).toHaveLength(0);
  });

  test("table rename short-circuits column rename for that table", async () => {
    const expected = { tables: [table("articles")], views: [] };
    const actual = { tables: [table("posts")], views: [] };
    const r = await diff({
      expected, actual,
      onAmbiguous: async () => "rename",
    });
    expect(r.changes.find((c) => c.kind === "rename-column")).toBeUndefined();
  });

  // Build a table whose columns are all text + nullable, so the column-set
  // signature (name|kind|nullable) is driven purely by the column NAMES — which
  // lets us dial the Jaccard overlap precisely for the threshold boundary.
  function tableNamed(name: string, colNames: string[]) {
    return {
      name,
      columns: colNames.map((n) => ({ name: n, sqlType: { kind: "text" as const }, nullable: true })),
      indexes: [], foreignKeys: [], primaryKey: [], checks: [],
    };
  }

  test("Jaccard overlap == 0.8 (boundary, inclusive) → rename candidate", async () => {
    // drop posts {a,b,c,d} vs create articles {a,b,c,d,e}: |∩|=4, |∪|=5 → 0.8.
    const expected = { tables: [tableNamed("articles", ["a", "b", "c", "d", "e"])], views: [] };
    const actual = { tables: [tableNamed("posts", ["a", "b", "c", "d"])], views: [] };
    const calls: AmbiguousChange[] = [];
    const r = await diff({
      expected, actual,
      onAmbiguous: async (q) => { calls.push(q); return "rename"; },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "possible-table-rename", columnOverlap: 0.8 });
    expect(r.changes.find((c) => c.kind === "rename-table")).toMatchObject({ from: "posts", to: "articles" });
  });

  test("Jaccard overlap just below 0.8 → NOT a candidate (no callback)", async () => {
    // drop posts {a,b,c} vs create articles {a,b,c,d}: |∩|=3, |∪|=4 → 0.75 < 0.8.
    const expected = { tables: [tableNamed("articles", ["a", "b", "c", "d"])], views: [] };
    const actual = { tables: [tableNamed("posts", ["a", "b", "c"])], views: [] };
    const calls: AmbiguousChange[] = [];
    await diff({
      expected, actual, allow: { dropTable: true },
      onAmbiguous: async (q) => { calls.push(q); return "rename"; },
    });
    expect(calls).toHaveLength(0);
  });

  test("table candidate with 'abort' resolution throws", async () => {
    const expected = { tables: [table("articles")], views: [] };
    const actual = { tables: [table("posts")], views: [] };
    await expect(diff({
      expected, actual,
      onAmbiguous: async () => "abort",
    })).rejects.toThrow(/possible rename posts → articles/);
  });
});
