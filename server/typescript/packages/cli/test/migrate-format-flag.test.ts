// #192 — `meta migrate --format`. Output format is orthogonal to dialect (a
// Flyway shop is still on postgres or sqlite), so it is its own flag, validated
// against a closed set exactly as --dialect is.

import { describe, test, expect } from "bun:test";
import { parseMigrateArgs } from "../src/lib/args.js";

describe("migrate --format parsing", () => {
  test("absent --format leaves format undefined (config/default decides)", () => {
    expect(parseMigrateArgs([]).format).toBeUndefined();
  });

  test("--format flyway parses", () => {
    expect(parseMigrateArgs(["--format", "flyway"]).format).toBe("flyway");
  });

  test("--format default parses", () => {
    expect(parseMigrateArgs(["--format", "default"]).format).toBe("default");
  });

  test("an invalid --format is rejected, listing the valid values", () => {
    expect(() => parseMigrateArgs(["--format", "liquibase"])).toThrow(
      /invalid --format 'liquibase'; expected: default, flyway/,
    );
  });
});
