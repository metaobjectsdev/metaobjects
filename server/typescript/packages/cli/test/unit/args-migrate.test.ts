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
      d1Binding: undefined,
      remote: false,
      apply: false,
      rollback: undefined,
      yes: false,
      fromDb: false,
      baseline: false,
    });
  });

  test("--rollback captures the target", () => {
    expect(parseMigrateArgs(["--rollback", "20260101000000-init"]).rollback).toBe("20260101000000-init");
  });

  test("--rollback and --apply are mutually exclusive", () => {
    expect(() => parseMigrateArgs(["--rollback", "x", "--apply"])).toThrow(/mutually exclusive/i);
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

describe("parseMigrateArgs (d1 flags)", () => {
  test("accepts --dialect d1", () => {
    const flags = parseMigrateArgs(["--dialect", "d1"]);
    expect(flags.dialect).toBe("d1");
  });

  test("captures --d1 binding name", () => {
    const flags = parseMigrateArgs(["--dialect", "d1", "--d1", "MYDB"]);
    expect(flags.d1Binding).toBe("MYDB");
  });

  test("captures --remote as a boolean", () => {
    expect(parseMigrateArgs(["--dialect", "d1", "--remote"]).remote).toBe(true);
    expect(parseMigrateArgs(["--dialect", "d1"]).remote).toBe(false);
  });

  test("captures --apply as a boolean", () => {
    expect(parseMigrateArgs(["--dialect", "d1", "--apply"]).apply).toBe(true);
    expect(parseMigrateArgs(["--dialect", "d1"]).apply).toBe(false);
  });

  test("captures --yes as a boolean", () => {
    expect(parseMigrateArgs(["--dialect", "d1", "--yes"]).yes).toBe(true);
    expect(parseMigrateArgs(["--dialect", "d1"]).yes).toBe(false);
  });

  test("rejects unknown dialect", () => {
    expect(() => parseMigrateArgs(["--dialect", "mysql"])).toThrow(/invalid --dialect/);
  });
});
