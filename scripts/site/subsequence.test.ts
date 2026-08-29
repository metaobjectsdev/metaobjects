import { describe, test, expect } from "bun:test";
import { matchSubsequence, renderWithElisions, splitLines } from "./subsequence.js";

const FULL = [
  "import { z } from 'zod';",
  "",
  "export const a = 1;",
  "export const b = 2;",
  "export const c = 3;",
];

describe("splitLines", () => {
  test("drops the trailing '' that split() leaves on a newline-terminated file", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
  });

  test("keeps a genuine interior blank line", () => {
    expect(splitLines("a\n\nb\n")).toEqual(["a", "", "b"]);
  });

  test("drops only ONE trailing empty, so a deliberate blank last line survives", () => {
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
  });
});

describe("matchSubsequence", () => {
  test("matches a contiguous excerpt and reports its positions", () => {
    expect(matchSubsequence(["export const a = 1;", "export const b = 2;"], FULL))
      .toEqual({ ok: true, positions: [2, 3] });
  });

  test("matches a NON-contiguous excerpt — the page shows exports 1 and 3", () => {
    expect(matchSubsequence(["export const a = 1;", "export const c = 3;"], FULL))
      .toEqual({ ok: true, positions: [2, 4] });
  });

  test("compares trimmed, so trailing whitespace cannot fail it", () => {
    expect(matchSubsequence(["export const a = 1;   "], FULL).ok).toBe(true);
  });

  test("fails when a line is gone, naming the first line that did not match", () => {
    expect(matchSubsequence(["export const a = 1;", "export const RENAMED = 2;"], FULL))
      .toEqual({ ok: false, failedAt: 1, line: "export const RENAMED = 2;" });
  });

  test("fails when the excerpt is present but REORDERED", () => {
    expect(matchSubsequence(["export const c = 3;", "export const a = 1;"], FULL).ok)
      .toBe(false);
  });

  // Every real caller reads a newline-terminated file, so this is the shape the
  // gate ALWAYS receives. Unstripped, the trailing "" is a line the matcher has to
  // find: with no blank line left after the cursor it FAILS a correct excerpt, and
  // with one it silently consumes that position and skews every later elision.
  // Both are wrong; splitLines removes the cause.
  test("a raw split() trailing empty FAILS a correct excerpt", () => {
    const raw = "export const a = 1;\n".split("\n");        // ["export const a = 1;", ""]
    expect(matchSubsequence(raw, FULL))
      .toEqual({ ok: false, failedAt: 1, line: "" });
  });

  test("...and the same excerpt through splitLines matches", () => {
    expect(matchSubsequence(splitLines("export const a = 1;\n"), FULL))
      .toEqual({ ok: true, positions: [2] });
  });

  test("a raw trailing empty SKEWS when a blank line remains after the cursor", () => {
    const withBlank = ["import { z } from 'zod';", ""];        // as split() would give
    // The "" binds to FULL[1], the file's real blank line — a position the excerpt
    // never meant to claim, which suppresses the elision that belongs after it.
    expect(matchSubsequence(withBlank, FULL))
      .toEqual({ ok: true, positions: [0, 1] });
  });
});

describe("renderWithElisions", () => {
  test("inserts an elision at an interior gap", () => {
    // positions[0] is 2, so lines 0-1 were skipped too — the leading elision is
    // correct and load-bearing: the page must not imply the excerpt starts the file.
    expect(renderWithElisions(["export const a = 1;", "export const c = 3;"], [2, 4], 5))
      .toEqual(["…", "export const a = 1;", "…", "export const c = 3;"]);
  });

  test("inserts an interior elision with no leading one when the excerpt starts at line 0", () => {
    expect(renderWithElisions(["import { z } from 'zod';", "export const c = 3;"], [0, 4], 5))
      .toEqual(["import { z } from 'zod';", "…", "export const c = 3;"]);
  });

  test("inserts a LEADING elision when the excerpt does not start at the top", () => {
    expect(renderWithElisions(["export const a = 1;"], [2], 5))
      .toEqual(["…", "export const a = 1;", "…"]);
  });

  test("inserts no elision when the excerpt is the whole file", () => {
    expect(renderWithElisions(FULL, [0, 1, 2, 3, 4], 5)).toEqual(FULL);
  });

  test("inserts a trailing elision when the excerpt stops short of the end", () => {
    expect(renderWithElisions(["import { z } from 'zod';"], [0], 5))
      .toEqual(["import { z } from 'zod';", "…"]);
  });
});
