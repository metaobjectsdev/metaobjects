import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { snapshotPaths, unifiedDiff } from "../../src/lib/snapshot.js";

describe("snapshotPaths", () => {
  test("resolves the per-template dir + payload + golden under .metaobjects/snapshots", () => {
    const p = snapshotPaths("/proj", "Greeting");
    expect(p.dir).toBe(join("/proj", ".metaobjects", "snapshots", "Greeting"));
    expect(p.payloadPath).toBe(join("/proj", ".metaobjects", "snapshots", "Greeting", "payload.json"));
    expect(p.snapPath).toBe(join("/proj", ".metaobjects", "snapshots", "Greeting", "output.snap"));
  });
});

describe("unifiedDiff", () => {
  test("identical strings produce no -/+ lines", () => {
    const d = unifiedDiff("a\nb\nc", "a\nb\nc");
    expect(d).not.toContain("\n- ");
    expect(d).not.toContain("\n+ ");
  });
  test("shows the differing region with - (expected) then + (actual)", () => {
    const d = unifiedDiff("a\nOLD\nc", "a\nNEW\nc");
    expect(d).toContain("- OLD");
    expect(d).toContain("+ NEW");
    // common leading/trailing lines are trimmed from the diff body
    expect(d).not.toContain("- a");
    expect(d).not.toContain("+ c");
  });
});
