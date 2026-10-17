// A pre-release CLI stamped its own version ("1.1.0-rc.4") into the committed
// .metaobjects/.agent-context.json ("generatedBy") with no warning at write time, and
// tools/prerelease/detect-prerelease-pins.sh said nothing about it either. This pins the
// predicate both sides key off: `isPrereleaseVersion`, used by `meta init` (see
// commands/init.ts) to decide whether to warn.
import { describe, test, expect } from "bun:test";
import { isPrereleaseVersion } from "../../src/lib/version.js";

describe("isPrereleaseVersion", () => {
  test("a plain release version is not a prerelease", () => {
    expect(isPrereleaseVersion("1.1.0")).toBe(false);
    expect(isPrereleaseVersion("0.24.5")).toBe(false);
    expect(isPrereleaseVersion("10.0.13")).toBe(false);
  });

  test("npm/NuGet/Maven-style prerelease suffixes are flagged", () => {
    expect(isPrereleaseVersion("1.1.0-rc.4")).toBe(true);
    expect(isPrereleaseVersion("1.1.0-alpha.1")).toBe(true);
    expect(isPrereleaseVersion("1.1.0-beta")).toBe(true);
    expect(isPrereleaseVersion("8.1.0-rc.9")).toBe(true);
  });

  test("Maven SNAPSHOT is flagged", () => {
    expect(isPrereleaseVersion("8.1.0-SNAPSHOT")).toBe(true);
  });

  test("the project's own 0.0.0 unresolved-version sentinel is not flagged", () => {
    expect(isPrereleaseVersion("0.0.0")).toBe(false);
  });

  test("whitespace around the version does not change the verdict", () => {
    expect(isPrereleaseVersion("  1.1.0-rc.4  ")).toBe(true);
    expect(isPrereleaseVersion("  1.1.0  ")).toBe(false);
  });

  test("a two-part or malformed version is not flagged (not this predicate's job)", () => {
    expect(isPrereleaseVersion("1.1")).toBe(false);
    expect(isPrereleaseVersion("not-a-version")).toBe(false);
  });
});
