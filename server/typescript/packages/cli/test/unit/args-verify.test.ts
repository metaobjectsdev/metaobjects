import { describe, test, expect } from "bun:test";
import { parseVerifyArgs } from "../../src/lib/args.js";
import { DEFAULT_ADVISORY_LIMIT } from "../../src/lib/advisory.js";

describe("parseVerifyArgs", () => {
  test("defaults: prompts/db/dialect undefined, allow empty, skipSchema false, no explicit subverb", () => {
    expect(parseVerifyArgs([])).toEqual({
      prompts: undefined, db: undefined, dialect: undefined, allow: [], skipSchema: false,
      templates: false, codegen: false, anyExplicit: false, noAntipatterns: false, noRequirementLint: false, lax: false,
      replay: false, replaySnapshot: false,
      d1: undefined, remote: false, limit: DEFAULT_ADVISORY_LIMIT,
    });
  });
  test("--prompts <dir> is captured", () => {
    expect(parseVerifyArgs(["--prompts", "templates"])).toEqual({
      prompts: "templates", db: undefined, dialect: undefined, allow: [], skipSchema: false,
      templates: false, codegen: false, anyExplicit: false, noAntipatterns: false, noRequirementLint: false, lax: false,
      replay: false, replaySnapshot: false,
      d1: undefined, remote: false, limit: DEFAULT_ADVISORY_LIMIT,
    });
  });
  test("--db / --dialect / --skip-schema are captured", () => {
    expect(parseVerifyArgs(["--db", "file:x.db", "--dialect", "sqlite", "--skip-schema"])).toEqual({
      prompts: undefined, db: "file:x.db", dialect: "sqlite", allow: [], skipSchema: true,
      templates: false, codegen: false, anyExplicit: true, noAntipatterns: false, noRequirementLint: false, lax: false,
      replay: false, replaySnapshot: false,
      d1: undefined, remote: false, limit: DEFAULT_ADVISORY_LIMIT,
    });
  });
  // #225 — --d1 <binding> and --remote, mirroring `meta migrate`'s spelling.
  // --dialect d1 alone is already an explicit subverb selector (D1 has no --db URL).
  test("--dialect d1 --d1 <binding> --remote are captured; --dialect d1 alone is an explicit subverb", () => {
    expect(parseVerifyArgs(["--dialect", "d1", "--d1", "DB", "--remote"])).toEqual({
      prompts: undefined, db: undefined, dialect: "d1", allow: [], skipSchema: false,
      templates: false, codegen: false, anyExplicit: true, noAntipatterns: false, noRequirementLint: false, lax: false,
      replay: false, replaySnapshot: false,
      d1: "DB", remote: true, limit: DEFAULT_ADVISORY_LIMIT,
    });
    const bare = parseVerifyArgs(["--dialect", "d1"]);
    expect(bare.anyExplicit).toBe(true);
    expect(bare.d1).toBeUndefined();
    expect(bare.remote).toBe(false);
  });
  test("--no-antipatterns is captured", () => {
    expect(parseVerifyArgs(["--no-antipatterns"]).noAntipatterns).toBe(true);
    expect(parseVerifyArgs([]).noAntipatterns).toBe(false);
  });
  // #96 — strict-by-default; --lax opts out (not a subverb, so anyExplicit stays false).
  test("--lax is captured and does not count as an explicit subverb", () => {
    const f = parseVerifyArgs(["--lax"]);
    expect(f.lax).toBe(true);
    expect(f.anyExplicit).toBe(false);
    expect(parseVerifyArgs([]).lax).toBe(false);
  });
  test("--allow csv is parsed into tokens", () => {
    expect(parseVerifyArgs(["--allow", "drop-column,drop-table"])).toEqual({
      prompts: undefined, db: undefined, dialect: undefined,
      allow: ["drop-column", "drop-table"], skipSchema: false,
      templates: false, codegen: false, anyExplicit: false, noAntipatterns: false, noRequirementLint: false, lax: false,
      replay: false, replaySnapshot: false,
      d1: undefined, remote: false, limit: DEFAULT_ADVISORY_LIMIT,
    });
  });

  // ADR-0021 D2 — explicit subverbs.
  test("--templates sets the explicit-subverb flags", () => {
    const f = parseVerifyArgs(["--templates"]);
    expect(f.templates).toBe(true);
    expect(f.codegen).toBe(false);
    expect(f.anyExplicit).toBe(true);
  });
  test("--codegen sets the explicit-subverb flags", () => {
    const f = parseVerifyArgs(["--codegen"]);
    expect(f.codegen).toBe(true);
    expect(f.templates).toBe(false);
    expect(f.anyExplicit).toBe(true);
  });
  test("--templates --codegen together both set; anyExplicit true", () => {
    const f = parseVerifyArgs(["--templates", "--codegen"]);
    expect(f.templates).toBe(true);
    expect(f.codegen).toBe(true);
    expect(f.anyExplicit).toBe(true);
  });
  test("--no-requirement-lint mutes the advisory lint, and defaults off", () => {
    expect(parseVerifyArgs([]).noRequirementLint).toBe(false);
    expect(parseVerifyArgs(["--no-requirement-lint"]).noRequirementLint).toBe(true);
    // It is a mute for the ADVISORY half only — nothing here touches the gate, which
    // is the whole reason the two print as separate sections.
    expect(parseVerifyArgs(["--no-requirement-lint"]).anyExplicit).toBe(false);
  });
  test("throws on an invalid --dialect", () => {
    expect(() => parseVerifyArgs(["--dialect", "oracle"])).toThrow(/invalid --dialect 'oracle'/);
  });
  test("throws on an invalid --allow token", () => {
    expect(() => parseVerifyArgs(["--allow", "drop-everything"])).toThrow(
      /invalid --allow token 'drop-everything'/,
    );
  });
  test("throws on an unknown flag", () => {
    expect(() => parseVerifyArgs(["--bogus"])).toThrow(/Unknown option '--bogus'/);
  });
  test("throws on a positional argument", () => {
    expect(() => parseVerifyArgs(["extra"])).toThrow(/Unexpected argument 'extra'/);
  });
});
