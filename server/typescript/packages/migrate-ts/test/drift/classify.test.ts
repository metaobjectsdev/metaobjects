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

  test("CHECK changes: add-check is drift, drop-check is unmanaged", () => {
    // add-check = snapshot has a CHECK the DB lacks → actionable drift.
    // drop-check = DB has a CHECK the snapshot lacks → DB-only object, same as a
    // hand-authored drop-index/drop-fk → unmanaged (never auto-dropped).
    const { drift, unmanaged } = classifyDrift([mk("add-check"), mk("drop-check")]);
    expect(drift.map((c) => c.kind)).toEqual(["add-check"]);
    expect(unmanaged.map((c) => c.kind)).toEqual(["drop-check"]);
  });

  test("empty input yields empty partitions", () => {
    const { drift, unmanaged } = classifyDrift([]);
    expect(drift).toEqual([]);
    expect(unmanaged).toEqual([]);
  });
});
