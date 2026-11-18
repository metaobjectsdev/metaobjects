// The recreate note vouches only for views whose declared definition still fits the change;
// a view whose body names a column the migration renames gets the advisory instead.
import { test, expect } from "bun:test";
import type { Change } from "@metaobjectsdev/migrate-ts";
import { viewRecreateNote } from "../src/lib/allow.js";
import { schemaAdvisoryLines } from "../src/lib/schema-advisories.js";

const recreate = (name: string, sql: string): Change => ({
  kind: "create-view", view: { name, sql }, status: { state: "allowed" },
  reason: { kind: "unchanged", tables: ["time_entries"] },
});
const rename: Change = {
  kind: "rename-column", table: "time_entries", from: "hours", to: "duration_hours", status: { state: "allowed" },
};

test("a recreated view still naming the renamed column is left out of the note", () => {
  const note = viewRecreateNote([
    rename,
    recreate("v_stale", "SELECT sum(hours) FROM time_entries"),
    recreate("v_other", "SELECT count(*) FROM time_entries"),
  ]);
  expect(note).toBe(
    "1 view(s) keep their declared definition and are recreated only because the migration alters a table they read: v_other",
  );
});

test("the advisory names the view, the column and the fix", () => {
  const [line] = schemaAdvisoryLines([
    { kind: "view-names-renamed-column", table: "time_entries", column: "hours", to: "duration_hours", view: "v_stale" },
  ]);
  expect(line).toContain("view v_stale still names time_entries.hours");
  expect(line).toContain("fails at apply");
});
