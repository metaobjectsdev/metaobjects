import { describe, test, expect } from "bun:test";
import { parseVerifyArgs } from "../../src/lib/args.js";

describe("parseVerifyArgs", () => {
  test("defaults: prompts/db/dialect undefined, allow empty, skipSchema false", () => {
    expect(parseVerifyArgs([])).toEqual({
      prompts: undefined, db: undefined, dialect: undefined, allow: [], skipSchema: false,
    });
  });
  test("--prompts <dir> is captured", () => {
    expect(parseVerifyArgs(["--prompts", "templates"])).toEqual({
      prompts: "templates", db: undefined, dialect: undefined, allow: [], skipSchema: false,
    });
  });
  test("--db / --dialect / --skip-schema are captured", () => {
    expect(parseVerifyArgs(["--db", "file:x.db", "--dialect", "sqlite", "--skip-schema"])).toEqual({
      prompts: undefined, db: "file:x.db", dialect: "sqlite", allow: [], skipSchema: true,
    });
  });
  test("--allow csv is parsed into tokens", () => {
    expect(parseVerifyArgs(["--allow", "drop-column,drop-table"])).toEqual({
      prompts: undefined, db: undefined, dialect: undefined,
      allow: ["drop-column", "drop-table"], skipSchema: false,
    });
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
