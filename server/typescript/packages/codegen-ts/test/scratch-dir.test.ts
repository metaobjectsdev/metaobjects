import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeScratchDir, removeTree, scratchRoot } from "../src/scratch-dir.js";

describe("scratch-dir", () => {
  test("makeScratchDir is unique, under the scratch root, and removeTree clears a populated tree", () => {
    const a = makeScratchDir("scratch-dir-test-");
    const b = makeScratchDir("scratch-dir-test-");
    expect(a).not.toBe(b);
    expect(a.startsWith(scratchRoot())).toBe(true);
    mkdirSync(join(a, "x", "y"), { recursive: true });
    writeFileSync(join(a, "x", "y", "f.txt"), "1");
    removeTree(a);
    removeTree(b);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
  });

  test("removeTree of an absent path is not an error", () => {
    const a = makeScratchDir("scratch-dir-test-");
    removeTree(a);
    expect(() => removeTree(a)).not.toThrow();
  });
});
