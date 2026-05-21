import { describe, test, expect } from "bun:test";
import { emitSqliteViewMigration } from "../src/view-ddl-sqlite.js";

const createSql = `CREATE VIEW v_program_summary AS SELECT * FROM programs;`;

describe("emitSqliteViewMigration", () => {
  test("safe-append → DROP + CREATE in BEGIN/COMMIT", () => {
    const out = emitSqliteViewMigration({ diffClass: "safe-append", viewName: "v_program_summary", createSql });
    expect(out).toContain("BEGIN");
    expect(out).toContain("DROP VIEW IF EXISTS v_program_summary");
    expect(out).toContain("CREATE VIEW v_program_summary");
    expect(out).toContain("COMMIT");
  });

  test("breaking → same as safe-append (SQLite has no CASCADE; dependent views must be regenerated)", () => {
    const out = emitSqliteViewMigration({ diffClass: "breaking", viewName: "v_program_summary", createSql });
    expect(out).toContain("DROP VIEW IF EXISTS v_program_summary");
    expect(out).toContain("CREATE VIEW v_program_summary");
  });

  test("no-change → empty", () => {
    expect(emitSqliteViewMigration({ diffClass: "no-change", viewName: "v_x", createSql })).toBe("");
  });
});
