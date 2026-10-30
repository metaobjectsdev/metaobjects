import { describe, expect, test } from "bun:test";
import { reorderedSuffix } from "../src/commands/eject.js";
import { compareOwnedCopy } from "../src/lib/owned-copy.js";

describe("a pure reorder of an owned copy", () => {
  test("is a `differs` verdict with 0/0 counts, and the listing says reordered", async () => {
    const reference = "export const a = 1;\nexport const b = 2;\n";
    const owned = "export const b = 2;\nexport const a = 1;\n";
    const r = await compareOwnedCopy(owned, reference);
    expect(r.verdict).toBe("differs");
    expect(r.localOnly).toBe(0);
    expect(r.referenceOnly).toBe(0);
    expect(reorderedSuffix(r.referenceOnly, r.localOnly)).toBe(", reordered");
  });

  test("a real difference carries no reordered suffix", () => {
    expect(reorderedSuffix(0, 1)).toBe("");
    expect(reorderedSuffix(2, 0)).toBe("");
  });
});
