import { describe, test, expect } from "bun:test";
import { parseMigrateArgs } from "../src/lib/args.js";

describe("parseMigrateArgs — snapshot mode", () => {
  test("defaults: not from-db, not baseline", () => {
    const f = parseMigrateArgs([]);
    expect(f.fromDb).toBe(false);
    expect(f.baseline).toBe(false);
  });

  test("--from-db sets fromDb", () => {
    expect(parseMigrateArgs(["--from-db"]).fromDb).toBe(true);
  });

  test("'baseline' positional sets baseline", () => {
    const f = parseMigrateArgs(["baseline"]);
    expect(f.baseline).toBe(true);
    expect(f.fromDb).toBe(false);
  });

  test("'baseline --from-db' sets both", () => {
    const f = parseMigrateArgs(["baseline", "--from-db"]);
    expect(f.baseline).toBe(true);
    expect(f.fromDb).toBe(true);
  });
});

describe("parseMigrateArgs — --allow tokens", () => {
  test("drop-check and drop-view are valid tokens (drop-check gates enum @values evolution; drop-view gates real view removals)", () => {
    // Both were previously REJECTED here ("invalid --allow token"), making the
    // corresponding AllowOptions permissions impossible to grant from the CLI.
    const f = parseMigrateArgs(["--allow", "drop-check,drop-view"]);
    expect(f.allow).toEqual(["drop-check", "drop-view"]);
  });

  test("an unknown token is still rejected", () => {
    expect(() => parseMigrateArgs(["--allow", "drop-everything"])).toThrow(/invalid --allow token/);
  });
});
