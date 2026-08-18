// FR-038 §8 — the gen-state readers orphan reconciliation is built on.
//
// `.gen-state/.hashes.json` is the only record of what a previous run wrote, so
// its key set IS the "previously generated" universe. These tests pin the three
// properties the reconciliation decision depends on: the key list is complete,
// the snapshot read REFUSES a tampered snapshot (returns undefined rather than
// stale text), and forgetting a path removes both halves of the record.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideAndWrite,
  listGeneratedPaths,
  readGeneratedSnapshot,
  forgetGeneratedPaths,
} from "../src/overwrite-policy.js";

let root: string;
let genStateDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gen-state-readers-"));
  genStateDir = join(root, ".gen-state");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write `relPath` through the real policy so the snapshot + hash are produced
 *  exactly the way a `meta gen` run produces them. */
function generate(relPath: string, content: string): void {
  decideAndWrite(join(root, relPath), content, {
    genStateDir,
    outputRelPath: relPath,
  });
}

describe("listGeneratedPaths", () => {
  test("is empty for a gen-state directory that does not exist yet", () => {
    expect(listGeneratedPaths(join(root, "never-written"))).toEqual([]);
  });

  test("names every path a previous run wrote, and nothing else", () => {
    generate("out/Council.ts", "export const a = 1;\n");
    generate("tests/requirements/links.test.ts", "// stub\n");
    expect(listGeneratedPaths(genStateDir).sort()).toEqual([
      "out/Council.ts",
      "tests/requirements/links.test.ts",
    ]);
  });
});

describe("readGeneratedSnapshot", () => {
  test("returns the snapshot text for a generated path", () => {
    generate("out/Council.ts", "export const a = 1;\n");
    expect(readGeneratedSnapshot(genStateDir, "out/Council.ts")).toBe(
      "export const a = 1;\n",
    );
  });

  test("returns undefined for a path never generated", () => {
    generate("out/Council.ts", "export const a = 1;\n");
    expect(readGeneratedSnapshot(genStateDir, "out/Nope.ts")).toBeUndefined();
  });

  test("returns undefined when the SNAPSHOT ITSELF was tampered with", () => {
    // The hash guard is the whole point: with a snapshot we cannot trust, we
    // cannot prove the output file is untouched — and reconciliation must then
    // refuse rather than delete. Returning the stale text would let it delete.
    generate("out/Council.ts", "export const a = 1;\n");
    writeFileSync(join(genStateDir, "out/Council.ts"), "export const a = 999;\n");
    expect(readGeneratedSnapshot(genStateDir, "out/Council.ts")).toBeUndefined();
  });
});

describe("forgetGeneratedPaths", () => {
  test("drops the snapshot file AND the hash entry", () => {
    generate("out/Council.ts", "export const a = 1;\n");
    generate("out/Keep.ts", "export const b = 2;\n");

    forgetGeneratedPaths(genStateDir, ["out/Council.ts"]);

    expect(listGeneratedPaths(genStateDir)).toEqual(["out/Keep.ts"]);
    expect(existsSync(join(genStateDir, "out/Council.ts"))).toBe(false);
    // The surviving entry is untouched — forgetting is scoped to the set, not a reset.
    expect(readGeneratedSnapshot(genStateDir, "out/Keep.ts")).toBe(
      "export const b = 2;\n",
    );
    const hashes = JSON.parse(
      readFileSync(join(genStateDir, ".hashes.json"), "utf-8"),
    ) as Record<string, string>;
    expect(Object.keys(hashes)).toEqual(["out/Keep.ts"]);
  });

  test("clears a whole set in one pass", () => {
    // The reason this function is batched at all: a sweep clears k orphans together,
    // and a per-path variant rewrote the entire manifest k times for the same result.
    generate("out/A.ts", "export const a = 1;\n");
    generate("out/B.ts", "export const b = 2;\n");
    generate("out/Keep.ts", "export const c = 3;\n");

    forgetGeneratedPaths(genStateDir, ["out/A.ts", "out/B.ts"]);

    expect(listGeneratedPaths(genStateDir)).toEqual(["out/Keep.ts"]);
    expect(existsSync(join(genStateDir, "out/A.ts"))).toBe(false);
    expect(existsSync(join(genStateDir, "out/B.ts"))).toBe(false);
  });

  test("is a no-op for a path that was never generated", () => {
    generate("out/Keep.ts", "export const b = 2;\n");
    expect(() => forgetGeneratedPaths(genStateDir, ["out/Nope.ts"])).not.toThrow();
    expect(listGeneratedPaths(genStateDir)).toEqual(["out/Keep.ts"]);
  });

  test("an empty set leaves the manifest untouched", () => {
    generate("out/Keep.ts", "export const b = 2;\n");
    const before = readFileSync(join(genStateDir, ".hashes.json"), "utf-8");
    forgetGeneratedPaths(genStateDir, []);
    expect(readFileSync(join(genStateDir, ".hashes.json"), "utf-8")).toBe(before);
  });
});
