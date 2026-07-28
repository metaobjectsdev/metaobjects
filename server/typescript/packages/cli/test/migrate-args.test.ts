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

describe("parseMigrateArgs — apply-pending subcommand", () => {
  test("recognizes the apply-pending positional", () => {
    const f = parseMigrateArgs(["apply-pending", "--db", "file:t.db", "--dialect", "sqlite"]);
    expect(f.applyPending).toBe(true);
    expect(f.baseline).toBe(false);
    expect(f.db).toBe("file:t.db");
    expect(f.dialect).toBe("sqlite");
  });

  test("no subcommand → applyPending false", () => {
    expect(parseMigrateArgs([]).applyPending).toBe(false);
  });

  test("baseline positional still parses and does not set applyPending", () => {
    const f = parseMigrateArgs(["baseline"]);
    expect(f.baseline).toBe(true);
    expect(f.applyPending).toBe(false);
  });

  test("an unknown subcommand still throws, now listing apply-pending", () => {
    expect(() => parseMigrateArgs(["bogus"])).toThrow(/apply-pending/);
  });
});
