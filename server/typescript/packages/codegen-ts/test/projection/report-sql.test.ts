// FR-044 Plan 4 Task 1 — the report SQL fragments live in one module that the view lowering
// and the Cube exporter share. The goldens in report-ddl-emit.test.ts and
// extract-report-spec.test.ts pin the behaviour; this pins the one reuse the move is for.
import { describe, test, expect } from "bun:test";
import { ref } from "../../src/projection/report-sql.js";

describe("ref", () => {
  test("quotes the column and leaves the {CUBE} alias as written", () => {
    expect(ref("{CUBE}.status", "postgres")).toBe('{CUBE}."status"');
  });

  test("leaves the alias of a joined cube as written", () => {
    expect(ref("{Program}.title", "postgres")).toBe('{Program}."title"');
  });

  test("a generated join alias stays unquoted too", () => {
    expect(ref("p.title", "mysql")).toBe("p.`title`");
  });
});
