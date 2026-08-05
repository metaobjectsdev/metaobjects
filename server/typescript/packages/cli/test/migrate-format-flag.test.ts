// #192 — `meta migrate --migration-format`. The migration LAYOUT is orthogonal to
// dialect (a Flyway shop is still on postgres or sqlite), so it is its own flag,
// validated against a closed set exactly as --dialect is.
//
// Deliberately NOT `--format`: that name is already taken by the GLOBAL output
// flag (toon|json|text), consumed in index.ts before a command ever sees it.

import { describe, test, expect } from "bun:test";
import { parseMigrateArgs } from "../src/lib/args.js";

describe("migrate --migration-format parsing", () => {
  test("absent --migration-format leaves format undefined (config/default decides)", () => {
    expect(parseMigrateArgs([]).format).toBeUndefined();
  });

  test("--migration-format flyway parses", () => {
    expect(parseMigrateArgs(["--migration-format", "flyway"]).format).toBe("flyway");
  });

  test("--migration-format default parses", () => {
    expect(parseMigrateArgs(["--migration-format", "default"]).format).toBe("default");
  });

  test("an invalid --migration-format is rejected, listing the valid values", () => {
    expect(() => parseMigrateArgs(["--migration-format", "liquibase"])).toThrow(
      /invalid --migration-format 'liquibase'; expected: default, flyway/,
    );
  });
});
