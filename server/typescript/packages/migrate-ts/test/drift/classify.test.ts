// test/drift/classify.test.ts
import { describe, test, expect } from "bun:test";
import type { Change } from "../../src/types.js";
import { classifyDrift } from "../../src/drift/classify.js";

// Classification reads only `kind`; a minimal cast is enough for this unit.
const mk = (kind: string): Change => ({ kind, status: { state: "ok" } } as unknown as Change);

describe("classifyDrift", () => {
  test("drop-* changes are unmanaged; everything else is drift", () => {
    const { drift, unmanaged } = classifyDrift([
      mk("create-table"),
      mk("drop-table"),
      mk("add-column"),
      mk("drop-column"),
      mk("change-column-type"),
      mk("add-index"),
      mk("drop-index"),
      mk("add-fk"),
      mk("drop-fk"),
      mk("create-view"),
      mk("drop-view"),
      mk("replace-view"),
    ]);
    expect(unmanaged.map((c) => c.kind)).toEqual([
      "drop-table", "drop-column", "drop-index", "drop-fk", "drop-view",
    ]);
    expect(drift.map((c) => c.kind)).toEqual([
      "create-table", "add-column", "change-column-type",
      "add-index", "add-fk", "create-view", "replace-view",
    ]);
  });

  test("empty input yields empty partitions", () => {
    const { drift, unmanaged } = classifyDrift([]);
    expect(drift).toEqual([]);
    expect(unmanaged).toEqual([]);
  });
});
