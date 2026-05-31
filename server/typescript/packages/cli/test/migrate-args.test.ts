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
