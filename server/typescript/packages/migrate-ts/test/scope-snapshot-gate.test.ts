/**
 * `excludeFromSnapshot` — the scoped-diff door for a COMMITTED SNAPSHOT.
 *
 * `verify`'s committed-snapshot gate (#292) runs a SECOND comparison over the same
 * run: the committed `.schema.<dialect>.json` against the live database. It owes the
 * same three obligations as every other scoped diff (migrate-ts `scope.ts` header),
 * and it was the one call site re-deriving them by hand — including the schema pin,
 * which it derived from the SNAPSHOT rather than from the model.
 *
 * That re-derivation left one door open: a snapshot that is present but EMPTY (a
 * never-migrated project) declares no schemas at all, so the pin came out empty, the
 * caller's `length > 0` guard dropped it, and `diff` fell back to "no model, govern
 * the whole database" — reporting every table another owner has, in schemas this
 * model never mentions, as a snapshot disagreement.
 */
import { describe, test, expect } from "bun:test";
import { diff } from "../src/diff/index.js";
import { excludeFromSnapshot, scopedDiffInputs } from "../src/scope.js";
import type { SchemaSnapshot, TableDescriptor } from "../src/types.js";

function table(name: string, schema: string): TableDescriptor {
  return {
    name,
    schema,
    columns: [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
    ],
    indexes: [],
    foreignKeys: [],
    primaryKey: ["id"],
    checks: [],
  };
}

/** A never-migrated committed snapshot: the file exists, it records nothing. */
const EMPTY_SNAPSHOT: SchemaSnapshot = { tables: [], views: [] };

/** The live database: this consumer's table, the co-owner's table in the SAME
 *  schema (declared by the model, excluded by `migrate.scope`), and a third
 *  party's table in a schema this model never mentions at all. */
const ACTUAL: SchemaSnapshot = {
  tables: [table("jobs", "public"), table("matches", "public"), table("events", "analytics")],
  views: [],
};

/** The scope decision the drift comparison already made for this run: `matches` is
 *  another owner's, and the model declares into `public` only. */
const GOVERNED = { outOfScope: ["public.matches"], declaredSchemas: ["public"] };

describe("excludeFromSnapshot", () => {
  test("an EMPTY committed snapshot under a scope does not govern the whole database", async () => {
    const scoped = excludeFromSnapshot(EMPTY_SNAPSHOT, GOVERNED);
    const result = await diff({
      ...scopedDiffInputs(scoped, []),
      actual: ACTUAL,
      allow: {},
    });

    // analytics.events is a third party's, in a schema this model never declares.
    // It has no provenance, so it can never reach `outOfScope` — the SCHEMA pin is
    // the only thing that can protect it, and re-deriving that pin from the empty
    // snapshot is what handed `diff` the whole database instead.
    expect(result.changes.map((c) => JSON.stringify(c)).join("\n")).not.toContain("events");
    // The governed table is still compared: an empty snapshot really does disagree
    // with a database that holds `public.jobs`, and that finding must survive.
    expect(result.changes.filter((c) => c.kind === "drop-table")).toHaveLength(1);
    // …and the co-owner's in-schema table is suppressed through `unmanagedNames`.
    expect(result.changes.map((c) => JSON.stringify(c)).join("\n")).not.toContain("matches");
  });

  test("nothing out of scope returns the SAME snapshot object and no schema pin", () => {
    const scoped = excludeFromSnapshot(EMPTY_SNAPSHOT, { outOfScope: [], declaredSchemas: ["public"] });
    // Identity, not equality: an unscoped run's `diff` arguments must be exactly
    // what they were before scope existed.
    expect(scoped.snapshot).toBe(EMPTY_SNAPSHOT);
    expect(scoped.declaredSchemas).toBeUndefined();
    expect(scopedDiffInputs(scoped, ["public.legacy"])).toEqual({
      expected: EMPTY_SNAPSHOT,
      unmanagedNames: ["public.legacy"],
    });
  });

  test("out-of-scope entries leave the snapshot's own tables and views", () => {
    const snapshot: SchemaSnapshot = {
      tables: [table("jobs", "public"), table("matches", "public")],
      views: [],
    };
    const scoped = excludeFromSnapshot(snapshot, GOVERNED);
    expect(scoped.snapshot.tables.map((t) => t.name)).toEqual(["jobs"]);
    // The pin is the schemas the RUN governs, which is a property of the model —
    // not of whatever survived the filter.
    expect(scoped.declaredSchemas).toEqual(["public"]);
  });
});
