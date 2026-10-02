import { describe, test, expect } from "bun:test";
import { parseFmtArgs } from "../../src/lib/args.js";

describe("parseFmtArgs", () => {
  test("defaults — check false, no files", () => {
    expect(parseFmtArgs([])).toEqual({ check: false, files: [] });
  });

  test("--check sets check true", () => {
    expect(parseFmtArgs(["--check"])).toEqual({ check: true, files: [] });
  });

  test("positionals become the file list", () => {
    expect(parseFmtArgs(["a.json", "b.json"])).toEqual({
      check: false,
      files: ["a.json", "b.json"],
    });
  });

  test("--check combines with positionals in any order", () => {
    expect(parseFmtArgs(["a.json", "--check"])).toEqual({
      check: true,
      files: ["a.json"],
    });
  });

  test("unknown flag throws", () => {
    expect(() => parseFmtArgs(["--bogus"])).toThrow(/Unknown option '--bogus'/);
  });
});
