import { describe, test, expect } from "bun:test";
import { emitPostgresViewMigration } from "../src/view-ddl-postgres.js";

const createSql = `CREATE VIEW v_program_summary AS SELECT * FROM programs;`;

describe("emitPostgresViewMigration", () => {
  test("safe-append → CREATE OR REPLACE VIEW", () => {
    const out = emitPostgresViewMigration({ diffClass: "safe-append", viewName: "v_program_summary", createSql });
    expect(out).toContain("CREATE OR REPLACE VIEW v_program_summary");
  });

  test("safe-replace → CREATE OR REPLACE VIEW", () => {
    const out = emitPostgresViewMigration({ diffClass: "safe-replace", viewName: "v_program_summary", createSql });
    expect(out).toContain("CREATE OR REPLACE VIEW v_program_summary");
  });

  test("breaking → DROP VIEW ... CASCADE; CREATE VIEW", () => {
    const out = emitPostgresViewMigration({ diffClass: "breaking", viewName: "v_program_summary", createSql });
    expect(out).toContain("DROP VIEW IF EXISTS v_program_summary CASCADE");
    expect(out).toContain("CREATE VIEW v_program_summary");
  });

  test("no-change → empty string", () => {
    expect(emitPostgresViewMigration({ diffClass: "no-change", viewName: "v_x", createSql })).toBe("");
  });
});
