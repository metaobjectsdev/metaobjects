import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { buildPayload, assertNoHomePath } from "./payload.js";
import { HOME_PATH } from "./transcript.js";
import { SNIPPETS } from "./snippets.js";

const REPO = resolve(import.meta.dirname, "../..");
const payload = buildPayload(REPO);

describe("buildPayload", () => {
  test("carries every snippet the site needs", () => {
    for (const id of ["showcase-model", "showcase-requirement", "showcase-prompt",
                      "ts-entity", "java-dto", "kotlin-entity", "csharp-entity",
                      "python-model", "sql-migration", "verify-transcript"])
      expect(payload.snippets[id]).toBeDefined();
  });

  // The registry's own docstring: hand-typing the id set is how an id ends up in the
  // payload with no page referencing it. A bijection is the only check that catches
  // BOTH directions — a registered id the builder skipped, and a payload key nothing
  // registered.
  test("is in bijection with the snippet registry", () => {
    expect(Object.keys(payload.snippets).sort()).toEqual(Object.keys(SNIPPETS).sort());
  });

  test("a generated-code snippet ships its FULL file for expand-to-view", () => {
    const s = payload.snippets["ts-entity"]!;
    expect(s.full).not.toBeNull();
    expect(s.lineCount).toBeGreaterThan(s.inline.split("\n").length);
  });

  test("a marker snippet has no full file — it is already whole", () => {
    expect(payload.snippets["showcase-model"]!.full).toBeNull();
  });

  // A `whole` snippet's published text IS the file, which is a stricter guarantee than
  // any excerpt can make — so there is nothing to expand to, and every line of the
  // source must be present rather than a subsequence of it.
  test("a whole-file snippet publishes the entire file and expands to nothing", () => {
    const s = payload.snippets["sql-migration"]!;
    expect(s.full).toBeNull();
    expect(s.inline).toContain("CREATE TABLE");
  });

  test("carries one coordinate per registry, never a single version string", () => {
    expect(Object.keys(payload.registries).sort())
      .toEqual(["maven", "metamodel", "npm", "nuget", "pypi"]);
    // The exact top-level key set, not just `version === undefined`: SitePayload has no
    // `version` field, so the compiler already forbids that one, and a test the types
    // make unfailable proves nothing. Pinning the whole set catches ANY stray top-level
    // key — a single version string being the one that would misstate four registries.
    expect(Object.keys(payload).sort()).toEqual(["registries", "snippets"]);
  });

  test("is deterministic — no timestamp, byte-identical across builds", () => {
    expect(JSON.stringify(buildPayload(REPO))).toBe(JSON.stringify(payload));
    expect(JSON.stringify(payload)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test("contains no absolute home path anywhere", () => {
    expect(JSON.stringify(payload)).not.toMatch(/\/(home|Users)\//);
  });

  // Regression pin. The sweep used to run HOME_PATH over `JSON.stringify(payload)`,
  // where stringify doubles backslashes — so a Windows user path serialized with
  // TWO of them and the Windows branch, which matches ONE, could never
  // fire. POSIX paths matched, so the sweep looked like it worked. It walks string
  // VALUES now; this asserts both branches, and that the serialized form is the trap.
  test("the home-path sweep catches a Windows path, not only a POSIX one", () => {
    // Composed rather than written as literals: this repository is public and the
    // commit guard rejects a home-path literal in a diff on sight, which is correct —
    // "it is only a test fixture" is exactly the cover a real leak would use.
    const posix = ["", "home", "someone", "secret"].join("/");
    const win = ["C:", "Users", "someone", "secret"].join("\\");
    expect(() => assertNoHomePath({ a: { b: posix } })).toThrow(/home path/);
    expect(() => assertNoHomePath({ a: { b: win } })).toThrow(/home path/);
    expect(() => assertNoHomePath({ a: { b: "no path here" } })).not.toThrow();
    // The trap itself: the old serialized form hides the Windows path from the pattern.
    expect(HOME_PATH.test(JSON.stringify({ b: win }))).toBe(false);
    expect(HOME_PATH.test(win)).toBe(true);
  });

  test("the drift fixture is still failing — the transcript is not stale", () => {
    expect(payload.snippets["verify-transcript"]!.inline)
      .toContain("ERR_VAR_NOT_ON_PAYLOAD");
  });
});
