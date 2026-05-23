import { describe, test, expect } from "bun:test";
import { parseVerifyArgs } from "../../src/lib/args.js";

describe("parseVerifyArgs", () => {
  test("defaults prompts to undefined", () => {
    expect(parseVerifyArgs([])).toEqual({ prompts: undefined });
  });
  test("--prompts <dir> is captured", () => {
    expect(parseVerifyArgs(["--prompts", "templates"])).toEqual({ prompts: "templates" });
  });
  test("throws on an unknown flag", () => {
    expect(() => parseVerifyArgs(["--bogus"])).toThrow();
  });
  test("throws on a positional argument", () => {
    expect(() => parseVerifyArgs(["extra"])).toThrow();
  });
});
