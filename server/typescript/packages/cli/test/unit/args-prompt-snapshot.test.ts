import { describe, test, expect } from "bun:test";
import { parsePromptSnapshotArgs } from "../../src/lib/args.js";

describe("parsePromptSnapshotArgs", () => {
  test("defaults: check false, prompts undefined", () => {
    expect(parsePromptSnapshotArgs([])).toEqual({ check: false, prompts: undefined });
  });
  test("--check sets check true", () => {
    expect(parsePromptSnapshotArgs(["--check"])).toEqual({ check: true, prompts: undefined });
  });
  test("--prompts <dir> is captured", () => {
    expect(parsePromptSnapshotArgs(["--prompts", "templates"])).toEqual({
      check: false,
      prompts: "templates",
    });
  });
  test("throws on an unknown flag", () => {
    expect(() => parsePromptSnapshotArgs(["--bogus"])).toThrow(/Unknown option '--bogus'/);
  });
  test("throws on a positional argument", () => {
    expect(() => parsePromptSnapshotArgs(["extra"])).toThrow(/Unexpected argument 'extra'/);
  });
});
