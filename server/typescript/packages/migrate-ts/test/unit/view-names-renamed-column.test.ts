/**
 * A declared column rename never rewrites a view body. An `@sql` view still naming the old
 * column is recreated as written, and the migration fails at apply ("column … does not
 * exist") after `meta migrate` and `meta verify` both passed. The diff now says so as an
 * advisory, and the recreate note no longer claims such a view matches the metadata.
 */
import { test, expect, describe } from "bun:test";
import { diff } from "../../src/diff/index.js";
import { viewsNamingRenamedColumns } from "../../src/view-change-reason.js";
import type { SchemaSnapshot, TableDescriptor, ViewDescriptor } from "../../src/types.js";

function timeEntries(hoursColumn: string): TableDescriptor {
  return {
    name: "time_entries",
    columns: [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false },
      { name: hoursColumn, sqlType: { kind: "text" }, nullable: true },
    ],
    indexes: [],
    foreignKeys: [],
    primaryKey: ["id"],
    checks: [],
  };
}

const view = (body: string): ViewDescriptor => ({ name: "v_hours", sql: body });
const snap = (t: TableDescriptor, v: ViewDescriptor): SchemaSnapshot => ({ tables: [t], views: [v] });
const RENAME = [{ kind: "column" as const, table: "time_entries", from: "hours", to: "duration_hours" }];

describe("a recreated view whose body names a renamed column", () => {
  test("is reported as an advisory when its body was left on the old name", async () => {
    const stale = view("SELECT sum(hours) AS total FROM time_entries");
    const r = await diff({
      expected: snap(timeEntries("duration_hours"), stale),
      actual: snap(timeEntries("hours"), stale),
      renames: RENAME,
      dialect: "sqlite",
    });
    expect(r.changes.some((c) => c.kind === "create-view")).toBe(true);
    expect(r.advisories).toContainEqual({
      kind: "view-names-renamed-column", table: "time_entries", column: "hours", to: "duration_hours", view: "v_hours",
    });
  });

  test("is not reported once its body names the new column", async () => {
    const r = await diff({
      expected: snap(timeEntries("duration_hours"), view("SELECT sum(duration_hours) AS total FROM time_entries")),
      actual: snap(timeEntries("hours"), view("SELECT sum(hours) AS total FROM time_entries")),
      renames: RENAME,
      dialect: "sqlite",
    });
    expect(r.advisories.filter((a) => a.kind === "view-names-renamed-column")).toEqual([]);
  });

  test("a body that does not read the renamed column's table is not reported", () => {
    expect(viewsNamingRenamedColumns([
      { kind: "rename-column", table: "time_entries", from: "hours", to: "duration_hours", status: { state: "allowed" } },
      { kind: "create-view", view: view("SELECT hours FROM shifts"), status: { state: "allowed" } },
    ])).toEqual([]);
  });
});
