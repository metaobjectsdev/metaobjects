import { describe, test, expect } from "bun:test";
import { parseMigrateArgs } from "../../src/lib/args.js";

describe("parseMigrateArgs", () => {
  test("default flags", () => {
    expect(parseMigrateArgs([])).toEqual({
      db: undefined,
      dialect: undefined,
      outDir: undefined,
      slug: undefined,
      allow: [],
      onAmbiguous: undefined,
      dryRun: false,
    });
  });

  test("--db URL", () => {
    expect(parseMigrateArgs(["--db", "file:./test.db"]).db).toBe("file:./test.db");
  });

  test("--dialect sqlite|postgres", () => {
    expect(parseMigrateArgs(["--dialect", "sqlite"]).dialect).toBe("sqlite");
    expect(parseMigrateArgs(["--dialect", "postgres"]).dialect).toBe("postgres");
  });

  test("--dialect invalid throws", () => {
    expect(() => parseMigrateArgs(["--dialect", "mysql"])).toThrow(/dialect/i);
  });

  test("--out-dir", () => {
    expect(parseMigrateArgs(["--out-dir", "./migrations"]).outDir).toBe("./migrations");
  });

  test("--slug", () => {
    expect(parseMigrateArgs(["--slug", "add-user-email"]).slug).toBe("add-user-email");
  });

  test("--allow CSV parses into array", () => {
    const r = parseMigrateArgs(["--allow", "drop-column,drop-table"]);
    expect(r.allow).toEqual(["drop-column", "drop-table"]);
  });

  test("--allow single token", () => {
    expect(parseMigrateArgs(["--allow", "drop-column"]).allow).toEqual(["drop-column"]);
  });

  test("--allow invalid token throws", () => {
    expect(() => parseMigrateArgs(["--allow", "drop-column,burn-everything"])).toThrow(/allow.*burn-everything/i);
  });

  test("--on-ambiguous abort|rename|drop-add", () => {
    expect(parseMigrateArgs(["--on-ambiguous", "abort"]).onAmbiguous).toBe("abort");
    expect(parseMigrateArgs(["--on-ambiguous", "rename"]).onAmbiguous).toBe("rename");
    expect(parseMigrateArgs(["--on-ambiguous", "drop-add"]).onAmbiguous).toBe("drop-add");
  });

  test("--on-ambiguous invalid throws", () => {
    expect(() => parseMigrateArgs(["--on-ambiguous", "guess"])).toThrow(/on-ambiguous/i);
  });

  test("--dry-run", () => {
    expect(parseMigrateArgs(["--dry-run"]).dryRun).toBe(true);
  });

  test("unknown flag throws", () => {
    expect(() => parseMigrateArgs(["--foo"])).toThrow();
  });
});
