import { describe, test, expect } from "bun:test";
import { semanticDiff } from "../src/semantic-diff.js";

// MetaData-shaped fixtures using a stripped representation: just attrs +
// children + reserved keys. The diff algorithm doesn't actually need the
// MetaData class — it operates on canonical-JSON-shaped trees.

describe("semanticDiff", () => {
  test("identical empty trees: no diff", () => {
    expect(semanticDiff({}, {})).toBe(false);
  });

  test("identical attrs in different key order: no diff", () => {
    expect(semanticDiff({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
  });

  test("differing attr values: diff", () => {
    expect(semanticDiff({ a: 1 }, { a: 2 })).toBe(true);
  });

  test("differing child counts: diff", () => {
    expect(semanticDiff({ children: [{ a: 1 }] }, { children: [] })).toBe(true);
  });

  test("identical children in same order: no diff", () => {
    expect(semanticDiff(
      { children: [{ a: 1 }, { b: 2 }] },
      { children: [{ a: 1 }, { b: 2 }] },
    )).toBe(false);
  });

  test("source field excluded from diff", () => {
    expect(semanticDiff(
      { a: 1, source: { format: "json", files: ["x"], jsonPath: "$" } },
      { a: 1, source: { format: "code" } },
    )).toBe(false);
  });

  test("nested structure: no diff when deeply equal", () => {
    expect(semanticDiff(
      { x: { y: { z: 1 } } },
      { x: { y: { z: 1 } } },
    )).toBe(false);
  });

  test("nested structure: diff when leaf differs", () => {
    expect(semanticDiff(
      { x: { y: { z: 1 } } },
      { x: { y: { z: 2 } } },
    )).toBe(true);
  });
});
