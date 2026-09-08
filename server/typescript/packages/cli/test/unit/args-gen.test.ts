import { describe, test, expect } from "bun:test";
import { parseGenArgs } from "../../src/lib/args.js";
import { DEFAULT_ADVISORY_LIMIT } from "../../src/lib/advisory.js";

describe("parseGenArgs", () => {
  test("default flags", () => {
    expect(parseGenArgs([])).toEqual({
      dryRun: false,
      entities: [],
      baseline: "default",
      list: false,
      noAntipatterns: false,
      limit: DEFAULT_ADVISORY_LIMIT,
    });
  });

  test("--list", () => {
    expect(parseGenArgs(["--list"]).list).toBe(true);
  });

  test("--no-antipatterns", () => {
    expect(parseGenArgs(["--no-antipatterns"]).noAntipatterns).toBe(true);
  });

  test("--baseline=fresh", () => {
    expect(parseGenArgs(["--baseline=fresh"]).baseline).toBe("fresh");
  });

  test("--baseline=default (explicit)", () => {
    expect(parseGenArgs(["--baseline=default"]).baseline).toBe("default");
  });

  test("--baseline=adopt", () => {
    expect(parseGenArgs(["--baseline=adopt"]).baseline).toBe("adopt");
  });

  test("--baseline=invalid names every mode it will accept", () => {
    // The error is the only place a reader learns `adopt` exists at the moment they
    // most need it — they have just been refused and are guessing at flag values.
    expect(() => parseGenArgs(["--baseline=nonsense"])).toThrow(
      /invalid --baseline 'nonsense'; expected 'default', 'adopt' or 'fresh'/,
    );
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
    expect(() => parseGenArgs(["--foo"])).toThrow(/Unknown option '--foo'/);
  });
});
