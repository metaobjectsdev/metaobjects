import { test, expect, describe } from "bun:test";
import { buildWranglerExecuteArgs, parseWranglerExecuteJson } from "../../src/lib/wrangler.js";

describe("buildWranglerExecuteArgs", () => {
  test("local execution with command", () => {
    expect(buildWranglerExecuteArgs({
      binding: "DB",
      remote: false,
      command: "SELECT 1",
      configPath: "wrangler.toml",
    })).toEqual([
      "d1", "execute", "DB",
      "--local",
      "--json",
      "--command", "SELECT 1",
      "--config", "wrangler.toml",
    ]);
  });

  test("remote execution swaps --local for --remote", () => {
    const args = buildWranglerExecuteArgs({
      binding: "DB",
      remote: true,
      command: "SELECT 1",
      configPath: "wrangler.toml",
    });
    expect(args).toContain("--remote");
    expect(args).not.toContain("--local");
  });

  test("omits --config when configPath undefined", () => {
    const args = buildWranglerExecuteArgs({
      binding: "DB",
      remote: false,
      command: "SELECT 1",
      configPath: undefined,
    });
    expect(args).not.toContain("--config");
  });
});

describe("parseWranglerExecuteJson", () => {
  test("extracts rows from wrangler's standard envelope", () => {
    const stdout = JSON.stringify([{
      results: [{ id: 1, name: "alice" }, { id: 2, name: "bob" }],
      success: true,
      meta: {},
    }]);
    expect(parseWranglerExecuteJson(stdout)).toEqual([
      { id: 1, name: "alice" },
      { id: 2, name: "bob" },
    ]);
  });

  test("returns empty array when results missing", () => {
    expect(parseWranglerExecuteJson(JSON.stringify([{ success: true }]))).toEqual([]);
  });

  test("throws on malformed JSON", () => {
    expect(() => parseWranglerExecuteJson("not json")).toThrow(/parse|json/i);
  });

  test("throws when wrangler reports success: false", () => {
    const stdout = JSON.stringify([{ success: false, error: "no such table: foo" }]);
    expect(() => parseWranglerExecuteJson(stdout)).toThrow(/no such table: foo/);
  });

  test("throws when envelope is a bare object (not array-wrapped)", () => {
    const stdout = JSON.stringify({ success: true, results: [{ id: 1 }] });
    expect(() => parseWranglerExecuteJson(stdout)).toThrow(/non-empty array envelope/i);
  });
});
