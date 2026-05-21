import { describe, test, expect } from "bun:test";
import { computeViewMigrations, type ViewMigrationsOpts } from "../src/source-aware-diff.js";

describe("computeViewMigrations", () => {
  test("safe-append on sqlite emits drop+create wrapped in txn", () => {
    const result = computeViewMigrations({
      dialect: "sqlite",
      allowBreaking: false,
      views: [{
        viewName: "v_program_summary",
        prevShape: { columns: ["id", "title"] },
        nextShape: { columns: ["id", "title", "weekCount"] },
        createSql: "CREATE VIEW v_program_summary AS SELECT id, title, COUNT(*) AS weekCount FROM programs JOIN weeks ON weeks.program_id = programs.id GROUP BY id, title;",
      }],
    });
    expect(result.errors).toEqual([]);
    expect(result.migrations).toHaveLength(1);
    expect(result.migrations[0]).toContain("DROP VIEW IF EXISTS v_program_summary");
  });

  test("breaking + allowBreaking=false → error, no SQL", () => {
    const result = computeViewMigrations({
      dialect: "postgres",
      allowBreaking: false,
      views: [{
        viewName: "v_x",
        prevShape: { columns: ["a", "b"] },
        nextShape: { columns: ["a"] },          // dropped column = breaking
        createSql: "CREATE VIEW v_x AS SELECT a FROM t;",
      }],
    });
    expect(result.migrations).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("breaking");
  });

  test("breaking + allowBreaking=true → emits DROP CASCADE", () => {
    const result = computeViewMigrations({
      dialect: "postgres",
      allowBreaking: true,
      views: [{
        viewName: "v_x",
        prevShape: { columns: ["a", "b"] },
        nextShape: { columns: ["a"] },
        createSql: "CREATE VIEW v_x AS SELECT a FROM t;",
      }],
    });
    expect(result.errors).toEqual([]);
    expect(result.migrations).toHaveLength(1);
    expect(result.migrations[0]).toContain("DROP VIEW IF EXISTS v_x CASCADE");
  });
});
