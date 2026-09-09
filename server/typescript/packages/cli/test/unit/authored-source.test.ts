import { describe, test, expect } from "bun:test";
import { looksBundled } from "../../src/lib/authored-source.js";

describe("looksBundled", () => {
  test("ordinary source is not bundled", () => {
    expect(looksBundled(`export function f() {\n  return 1;\n}\n`)).toBe(false);
  });

  test("a long-but-human line is not bundled", () => {
    // A 900-char line is unpleasant and entirely possible in hand-written code.
    expect(looksBundled(`const x = "${"a".repeat(900)}";\n`)).toBe(false);
  });

  test("a minified line is bundled", () => {
    expect(looksBundled(`var a=1;${"b".repeat(6000)}\n`)).toBe(true);
  });

  test("the long line is found anywhere in the file, not just first", () => {
    expect(looksBundled(`// header\nconst a = 1;\n${"z".repeat(6000)}\nconst b = 2;\n`)).toBe(true);
  });

  test("a final line with no trailing newline still counts", () => {
    expect(looksBundled(`// header\n${"z".repeat(6000)}`)).toBe(true);
  });

  test("an empty file is not bundled", () => {
    expect(looksBundled("")).toBe(false);
  });
});
