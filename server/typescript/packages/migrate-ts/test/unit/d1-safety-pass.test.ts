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

  test("warns (via warnings array) when statement exceeds 100 KB", () => {
    const huge = "INSERT INTO x VALUES (" + "'a',".repeat(30000) + "'a');";
    const result = applyD1SafetyPass(huge, { collectWarnings: true });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/100\s?KB|too large/i);
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

  test("preserves empty lines collapsed to a single blank between statements", () => {
    const input = "CREATE TABLE a (id INT);\n\nCREATE TABLE b (id INT);";
    expect(applyD1SafetyPass(input)).toBe("CREATE TABLE a (id INT);\n\nCREATE TABLE b (id INT);");
  });

  test("noop on empty input", () => {
    expect(applyD1SafetyPass("")).toBe("");
  });
});
