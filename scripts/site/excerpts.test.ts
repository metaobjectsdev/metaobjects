import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { matchSubsequence, splitLines } from "./subsequence.js";
import { SNIPPETS } from "./snippets.js";

const REPO = resolve(import.meta.dirname, "../..");
const INLINE = resolve(REPO, "examples/showcase/inline");

describe("committed excerpts are real generated output", () => {
  test("every excerpt file has a registry entry — none is orphaned", () => {
    for (const f of readdirSync(INLINE)) {
      const id = f.replace(/\.txt$/, "");
      expect(SNIPPETS[id]?.kind).toBe("excerpt");
    }
  });

  test("every registry entry's files exist", () => {
    for (const [id, src] of Object.entries(SNIPPETS)) {
      const paths = src.kind === "marker" ? [src.file]
        : src.kind === "excerpt" ? [src.inline, src.full]
        : [src.cwd];
      for (const p of paths) {
        if (!existsSync(resolve(REPO, p))) throw new Error(`${id}: missing ${p}`);
      }
    }
  });

  for (const [id, src] of Object.entries(SNIPPETS)) {
    if (src.kind !== "excerpt") continue;
    test(`${id} is an in-order subsequence of ${src.full}`, () => {
      // splitLines, NOT split("\n") — a trailing "" skews or fails the match.
      const inline = splitLines(readFileSync(resolve(REPO, src.inline), "utf8"));
      const full = splitLines(readFileSync(resolve(REPO, src.full), "utf8"));
      const r = matchSubsequence(inline, full);
      if (!r.ok) {
        throw new Error(
          `${id}: line ${r.failedAt + 1} is no longer in ${src.full}:\n  ${r.line}`);
      }
      expect(r.ok).toBe(true);
    });
  }

  test("an excerpt is genuinely SHORTER than its source — else why excerpt", () => {
    for (const [id, src] of Object.entries(SNIPPETS)) {
      if (src.kind !== "excerpt") continue;
      const inline = splitLines(readFileSync(resolve(REPO, src.inline), "utf8"));
      const full = splitLines(readFileSync(resolve(REPO, src.full), "utf8"));
      expect({ id, shorter: inline.length < full.length })
        .toEqual({ id, shorter: true });
    }
  });
});
