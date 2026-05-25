import { test, expect, describe } from "bun:test";
import { buildWranglerExecuteArgs } from "../../src/lib/wrangler.js";

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

