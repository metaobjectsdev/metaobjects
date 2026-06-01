import { test, expect, describe } from "bun:test";
import { applyD1SafetyPass, D1UnsupportedStatementError } from "../../src/emit/d1-safety-pass.js";

describe("applyD1SafetyPass", () => {
  test("strips BEGIN TRANSACTION and COMMIT", () => {
    const input = "BEGIN TRANSACTION;\nCREATE TABLE x (id INT);\nCOMMIT;";
    expect(applyD1SafetyPass(input)).toBe("CREATE TABLE x (id INT);");
  });

  test("strips lowercase begin/commit and ROLLBACK", () => {
    const input = "begin;\nCREATE TABLE x (id INT);\nrollback;";
    expect(applyD1SafetyPass(input)).toBe("CREATE TABLE x (id INT);");
  });

  test("preserves PRAGMA foreign_keys = OFF/ON verbatim", () => {
    const input = "PRAGMA foreign_keys=OFF;\nCREATE TABLE x (id INT);\nPRAGMA foreign_keys=ON;";
    const out = applyD1SafetyPass(input);
    expect(out).toContain("PRAGMA foreign_keys=OFF;");
    expect(out).toContain("PRAGMA foreign_keys=ON;");
  });

  test("rejects ATTACH DATABASE with typed error", () => {
    expect(() => applyD1SafetyPass("ATTACH DATABASE 'foo' AS bar;"))
      .toThrow(D1UnsupportedStatementError);
  });

  test("rejects DETACH DATABASE with typed error", () => {
    expect(() => applyD1SafetyPass("DETACH DATABASE bar;"))
      .toThrow(D1UnsupportedStatementError);
  });

  test("rejects VACUUM with typed error", () => {
    expect(() => applyD1SafetyPass("VACUUM;"))
      .toThrow(D1UnsupportedStatementError);
  });

  test("strips SAVEPOINT / RELEASE / ROLLBACK TO", () => {
    const input = "SAVEPOINT s1;\nCREATE TABLE x (id INT);\nROLLBACK TO s1;\nRELEASE s1;";
    expect(applyD1SafetyPass(input)).toBe("CREATE TABLE x (id INT);");
  });

  test("warns (via warnings array) when statement exceeds 1 MB", () => {
    const huge = "INSERT INTO x VALUES (" + "'a',".repeat(300000) + "'a');";  // ~1.5 MB
    const result = applyD1SafetyPass(huge, { collectWarnings: true });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/1\s?MB|per-statement limit/i);
    expect(result.sql).toBe(huge.trim());
  });

  test("returns plain string when collectWarnings not set", () => {
    const out = applyD1SafetyPass("CREATE TABLE x (id INT);");
    expect(typeof out).toBe("string");
    expect(out).toBe("CREATE TABLE x (id INT);");
  });

  test("does not strip BEGIN inside a string literal", () => {
    const input = "INSERT INTO logs (msg) VALUES ('BEGIN TRANSACTION;');";
    expect(applyD1SafetyPass(input)).toBe(input);
  });

  test("does not split on a ';' inside a -- line comment", () => {
    // Regression: the old splitter only tracked single quotes, so a ';' inside a
    // comment split the statement into a broken fragment. A '-- …; …' comment
    // attached to a CREATE must stay attached as ONE statement.
    const input = "-- TODO: restore data; see backup\nCREATE TABLE t (id INT);";
    expect(applyD1SafetyPass(input)).toBe(input);
  });

  test("does not split on a ';' inside a /* block comment */", () => {
    const input = "/* drop; then */ CREATE TABLE z (id INT);";
    expect(applyD1SafetyPass(input)).toBe(input);
  });

  test("does not split on a ';' inside a double-quoted identifier", () => {
    const input = 'CREATE TABLE "od;d" (id INT);';
    expect(applyD1SafetyPass(input)).toBe(input);
  });

  test("collapses multiple blank lines between statements to a single blank", () => {
    const input = "CREATE TABLE a (id INT);\n\n\n\nCREATE TABLE b (id INT);";
    const expected = "CREATE TABLE a (id INT);\n\nCREATE TABLE b (id INT);";
    expect(applyD1SafetyPass(input)).toBe(expected);
  });

  test("noop on empty input", () => {
    expect(applyD1SafetyPass("")).toBe("");
  });
});
