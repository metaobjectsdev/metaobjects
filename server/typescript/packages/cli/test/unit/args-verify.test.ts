import { describe, test, expect } from "bun:test";
import { parseVerifyArgs } from "../../src/lib/args.js";

describe("parseVerifyArgs", () => {
  test("defaults: prompts/db/dialect undefined, allow empty, skipSchema false, no explicit subverb", () => {
    expect(parseVerifyArgs([])).toEqual({
      prompts: undefined, db: undefined, dialect: undefined, allow: [], skipSchema: false,
      templates: false, codegen: false, anyExplicit: false, noAntipatterns: false, lax: false,
    });
  });
  test("--prompts <dir> is captured", () => {
    expect(parseVerifyArgs(["--prompts", "templates"])).toEqual({
      prompts: "templates", db: undefined, dialect: undefined, allow: [], skipSchema: false,
      templates: false, codegen: false, anyExplicit: false, noAntipatterns: false, lax: false,
    });
  });
  test("--db / --dialect / --skip-schema are captured", () => {
    expect(parseVerifyArgs(["--db", "file:x.db", "--dialect", "sqlite", "--skip-schema"])).toEqual({
      prompts: undefined, db: "file:x.db", dialect: "sqlite", allow: [], skipSchema: true,
      templates: false, codegen: false, anyExplicit: true, noAntipatterns: false, lax: false,
    });
  });
  test("--no-antipatterns is captured", () => {
    expect(parseVerifyArgs(["--no-antipatterns"]).noAntipatterns).toBe(true);
    expect(parseVerifyArgs([]).noAntipatterns).toBe(false);
  });
  // #96 — strict-by-default; --lax opts out (not a subverb, so anyExplicit stays false).
  test("--lax is captured and does not count as an explicit subverb", () => {
    const f = parseVerifyArgs(["--lax"]);
    expect(f.lax).toBe(true);
    expect(f.anyExplicit).toBe(false);
    expect(parseVerifyArgs([]).lax).toBe(false);
  });
  test("--allow csv is parsed into tokens", () => {
    expect(parseVerifyArgs(["--allow", "drop-column,drop-table"])).toEqual({
      prompts: undefined, db: undefined, dialect: undefined,
      allow: ["drop-column", "drop-table"], skipSchema: false,
      templates: false, codegen: false, anyExplicit: false, noAntipatterns: false, lax: false,
    });
  });

  // ADR-0021 D2 — explicit subverbs.
  test("--templates sets the explicit-subverb flags", () => {
    const f = parseVerifyArgs(["--templates"]);
    expect(f.templates).toBe(true);
    expect(f.codegen).toBe(false);
    expect(f.anyExplicit).toBe(true);
  });
  test("--codegen sets the explicit-subverb flags", () => {
    const f = parseVerifyArgs(["--codegen"]);
    expect(f.codegen).toBe(true);
    expect(f.templates).toBe(false);
    expect(f.anyExplicit).toBe(true);
  });
  test("--templates --codegen together both set; anyExplicit true", () => {
    const f = parseVerifyArgs(["--templates", "--codegen"]);
    expect(f.templates).toBe(true);
    expect(f.codegen).toBe(true);
    expect(f.anyExplicit).toBe(true);
  });
  test("throws on an invalid --dialect", () => {
    expect(() => parseVerifyArgs(["--dialect", "oracle"])).toThrow();
  });
  test("throws on an invalid --allow token", () => {
    expect(() => parseVerifyArgs(["--allow", "drop-everything"])).toThrow();
  });
  test("throws on an unknown flag", () => {
    expect(() => parseVerifyArgs(["--bogus"])).toThrow();
  });
  test("throws on a positional argument", () => {
    expect(() => parseVerifyArgs(["extra"])).toThrow();
  });
});
