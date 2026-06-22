// SQLite emit ordering for a view over a recreated table. A column-type change
// triggers recreate-and-copy (DROP TABLE + RENAME __new_t). A dependent view must
// be DROPPED before that recreate (SQLite re-parses dependent views on rename and
// can error mid-recreate) and RECREATED after. This pins the STAGE_ORDER fix:
// drop-view=0 (was 99, which ran AFTER the recreate — the wrong order).
//
// Driven through diff() → emit() so the change shapes are exactly what production
// produces (Pass 2c injects the drop/create pair); no live SQLite DB is needed to
// verify the statement ORDER, which is the regression-prone part.

import { test, expect, describe } from "bun:test";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";
import type { SchemaSnapshot } from "../../src/types.js";

const BODY = "SELECT c FROM t";
function snap(colKind: "text" | "integer"): SchemaSnapshot {
  return {
    tables: [{
      name: "t",
      columns: [{ name: "c", sqlType: colKind === "integer" ? { kind: "integer", bits: 64 } : { kind: "text" }, nullable: true }],
      indexes: [], foreignKeys: [], primaryKey: [], checks: [],
    }],
    views: [{ name: "v", sql: BODY, dependsOn: ["t"] }],
  };
}

describe("sqlite emit — view over a recreated table", () => {
  test("drop-view precedes the recreate-and-copy, create-view follows it", async () => {
    // expected col integer, actual col text → change-column-type → sqlite recreate.
    const expected = snap("integer");
    // change-column-type is breaking-by-default; allow it so emit() proceeds.
    const r = await diff(expected, snap("text"), { dialect: "sqlite", allow: { typeChange: true } });
    const { up } = emit(r.changes, { dialect: "sqlite", expectedSchema: expected });

    const dropIdx = up.indexOf('DROP VIEW IF EXISTS "v"');
    const recreateIdx = up.indexOf("__new_t");          // renderRecreate's temp table
    const createIdx = up.indexOf('CREATE VIEW "v"');

    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(recreateIdx).toBeGreaterThanOrEqual(0);       // recreate actually happened
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(recreateIdx).toBeGreaterThan(dropIdx);        // view dropped BEFORE recreate
    expect(createIdx).toBeGreaterThan(recreateIdx);      // view recreated AFTER recreate
  });
});
