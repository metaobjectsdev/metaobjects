import { describe, test, expect } from "bun:test";
import { parseGenArgs } from "../../src/lib/args.js";

describe("parseGenArgs", () => {
  test("default flags", () => {
    expect(parseGenArgs([])).toEqual({
      dryRun: false,
      entities: [],
      baseline: "default",
    });
  });

  test("--baseline=fresh", () => {
    expect(parseGenArgs(["--baseline=fresh"]).baseline).toBe("fresh");
  });

  test("--baseline=default (explicit)", () => {
    expect(parseGenArgs(["--baseline=default"]).baseline).toBe("default");
  });

  test("--baseline=invalid throws", () => {
    expect(() => parseGenArgs(["--baseline=nonsense"])).toThrow();
  });

  test("--dry-run", () => {
    expect(parseGenArgs(["--dry-run"]).dryRun).toBe(true);
  });

  test("positional entity names", () => {
    expect(parseGenArgs(["User", "Post"]).entities).toEqual(["User", "Post"]);
  });

  test("mixed positionals and --dry-run", () => {
    const r = parseGenArgs(["User", "--dry-run", "Post"]);
    expect(r.entities).toEqual(["User", "Post"]);
    expect(r.dryRun).toBe(true);
  });

  test("unknown flag throws", () => {
    expect(() => parseGenArgs(["--foo"])).toThrow();
  });
});
