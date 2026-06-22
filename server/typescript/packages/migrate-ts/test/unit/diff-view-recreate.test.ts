/**
 * Pass 2c — view dependency-recreate. A column-altering change to a table a view
 * reads forces the view to be dropped before and recreated after (postgres blocks
 * ALTER on a column a view depends on; sqlite rebuilds the table). Body-unchanged
 * dependent views get no change from the body-compare pass (2b), so this pins the
 * dependency pass that picks them up — including the create-view/replace-view
 * interactions that, if wrong, re-introduce the double-CREATE bug.
 */
import { test, expect, describe } from "bun:test";
import { diff } from "../../src/diff/index.js";
import type { ColumnDescriptor, SchemaSnapshot, ViewDescriptor } from "../../src/types.js";

function col(name: string, kind: "text" | "integer"): ColumnDescriptor {
  return { name, sqlType: kind === "integer" ? { kind: "integer", bits: 64 } : { kind: "text" }, nullable: true };
}
function snap(colKind: "text" | "integer", views: ViewDescriptor[]): SchemaSnapshot {
  return {
    tables: [{ name: "t", columns: [col("c", colKind)], indexes: [], foreignKeys: [], primaryKey: [], checks: [] }],
    views,
  };
}
const BODY = "SELECT c FROM t";
const dependentView = (sql = BODY): ViewDescriptor => ({ name: "v", sql, dependsOn: ["t"] });

function kinds(changes: ReadonlyArray<{ kind: string }>): string[] {
  return changes.map((c) => c.kind);
}

describe("diff — Pass 2c view dependency-recreate", () => {
  test("column-altering change under a body-unchanged dependent view → drop+create injected", async () => {
    // expected col integer, actual col text → change-column-type on t.
    const r = await diff(snap("integer", [dependentView()]), snap("text", [dependentView()]));
    const k = kinds(r.changes);
    expect(k).toContain("change-column-type");
    expect(k).toContain("drop-view");
    expect(k).toContain("create-view");
    expect(k).not.toContain("replace-view");
    // exactly one of each view kind — not a double CREATE.
    expect(k.filter((x) => x === "create-view").length).toBe(1);
    expect(k.filter((x) => x === "drop-view").length).toBe(1);
  });

  test("body-changed view over a changed table → replace-view superseded by drop+create", async () => {
    const r = await diff(
      snap("integer", [dependentView("SELECT c AS renamed FROM t")]),
      snap("text", [dependentView(BODY)]),
    );
    const k = kinds(r.changes);
    expect(k).not.toContain("replace-view");
    expect(k.filter((x) => x === "create-view").length).toBe(1);
    expect(k.filter((x) => x === "drop-view").length).toBe(1);
  });

  test("brand-new view over a changed table → create-view only, no spurious drop", async () => {
    const r = await diff(snap("integer", [dependentView()]), snap("text", []));
    const k = kinds(r.changes);
    expect(k.filter((x) => x === "create-view").length).toBe(1);
    expect(k).not.toContain("drop-view");
  });

  test("column change on a table the view does NOT depend on → no view change", async () => {
    const independent: ViewDescriptor = { name: "v", sql: BODY, dependsOn: ["other"] };
    const r = await diff(snap("integer", [independent]), snap("text", [independent]));
    const k = kinds(r.changes);
    expect(k).toContain("change-column-type");
    expect(k).not.toContain("drop-view");
    expect(k).not.toContain("create-view");
    expect(k).not.toContain("replace-view");
  });
});
