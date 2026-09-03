// The schema engine inherits the primary-source divergence refusal.
//
// An object whose `@role: primary` sources resolve to more than one physical name
// has no single answer to give, and `buildExpectedSchema` binds ONE name per table
// unconditionally. The refusal used to live only in codegen-ts's
// `resolveObjectNames`, which runs only when the `names` generator is in the run —
// so with `namesFile()` unwired NOTHING refused, and `meta migrate` emitted DDL
// against the PARENT's table while the child declared its own. A refusal that
// depends on which consumer asked is not a refusal.
//
// It now lives in `primaryRdbSource` (@metaobjectsdev/metadata), which
// `resolveTableName` — Pass 1's table-name resolver here — delegates to. This file
// pins the WIRING: that the engine actually reaches it, on metadata the loader
// accepts with zero errors. `naming.test.ts` pins the refusal itself.

import { describe, test, expect } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  MetaModelError,
  isMetaSource,
  SOURCE_ROLE_PRIMARY,
} from "@metaobjectsdev/metadata";
import type { MetaSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";

// Two plain object.entity declarations, each naming its own table — the direction
// a writability-based comparison could never see, since both primaries are
// writable. `validateSourceRoles` enforces "exactly one primary" over ownChildren()
// only, so both survive on the child's effective children().
const DIVERGENT_BOTH_WRITABLE = {
  "metadata.root": {
    package: "acme",
    children: [
      { "object.entity": { name: "ParentWeird", abstract: true, children: [
        { "source.rdb": { name: "parentSrc", "@table": "parent_table" } },
        { "field.long": { name: "id" } },
      ] } },
      { "object.entity": { name: "ChildWeird", extends: "ParentWeird", children: [
        { "source.rdb": { name: "childSrc", "@table": "child_table" } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
      ] } },
    ],
  },
};

async function loadClean(json: unknown): Promise<MetaData> {
  const result = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(json)),
  ]);
  // Asserted, not assumed: a guard test whose fixture the loader would reject
  // proves nothing.
  expect(result.errors.map((e) => e.message)).toEqual([]);
  return result.root;
}

/** Pin the reachability MECHANISM: BOTH primary sources survive the child merge. If one
 *  shadowed the other there would be no divergence left to refuse and every assertion
 *  below would pass for the wrong reason. */
function expectBothPrimariesSurvive(root: MetaData, objectName: string, names: string[]): void {
  const child = root.children().find((c) => c.name === objectName)!;
  const primaries = child.children()
    .filter((c): c is MetaSource => isMetaSource(c) && c.role === SOURCE_ROLE_PRIMARY)
    .map((s) => s.physicalName)
    .sort();
  expect(primaries).toEqual([...names].sort());
}

describe("buildExpectedSchema — divergent primary sources", () => {
  test("refuses rather than emitting DDL against the inherited table", async () => {
    const root = await loadClean(DIVERGENT_BOTH_WRITABLE);
    expectBothPrimariesSurvive(root, "ChildWeird", ["parent_table", "child_table"]);
    expect(() => buildExpectedSchema(root)).toThrow(MetaModelError);
    // Each substring separately, so a message dropping one still fails.
    expect(() => buildExpectedSchema(root)).toThrow(/ChildWeird/);
    expect(() => buildExpectedSchema(root)).toThrow(/parent_table/);
    expect(() => buildExpectedSchema(root)).toThrow(/child_table/);
  });

  test("a single primary source still builds — the refusal is about DISAGREEMENT", async () => {
    const root = await loadClean({
      "metadata.root": {
        package: "acme",
        children: [
          { "object.entity": { name: "Widget", children: [
            { "source.rdb": { "@table": "widgets" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": "id" } },
          ] } },
        ],
      },
    });
    expect(buildExpectedSchema(root).tables.map((t) => t.name)).toEqual(["widgets"]);
  });
});
