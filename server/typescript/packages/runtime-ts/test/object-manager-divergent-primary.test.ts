// The metadata-driven RUNTIME inherits the primary-source divergence refusal.
//
// This is the exposure that made the refusal's old home wrong. It used to live
// only in codegen-ts's `resolveObjectNames`, which runs only when the `names`
// generator is in the run — so with `namesFile()` unwired an object whose
// `@role: primary` sources disagree got no refusal anywhere, and ObjectManager
// happily read and wrote the PARENT's table while the child declared its own.
// Wrong rows, silently, on every call. A refusal that depends on which consumer
// asked is not a refusal.
//
// It now lives in `primaryRdbSource` (@metaobjectsdev/metadata), which
// `resolveTableName` — ObjectManager's own `_tableName` and the query builder's
// table resolver — delegates to. This file pins the WIRING through the four CRUD
// verbs; `naming.test.ts` pins the refusal itself.

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
import { ObjectManager } from "../src/object-manager.js";
import { inMemoryDriver } from "../src/drivers/in-memory-driver.js";

// Two plain object.entity declarations, each naming its own table. Both primaries
// are WRITABLE, which is the direction a writability-based comparison could never
// see. `validateSourceRoles` enforces "exactly one primary" over ownChildren()
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
        { "field.string": { name: "label" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
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

function omFor(root: MetaData): ObjectManager {
  // Seeded on the PARENT's table on purpose: before the refusal moved, every verb
  // below resolved "parent_table" and returned/mutated these rows for an entity
  // that declares "child_table". The seed is what a passing read would have hit.
  return new ObjectManager({
    metadata: root,
    driver: inMemoryDriver({
      seed: { parent_table: [{ id: 1, label: "from the parent's table" }] },
      pkFields: { parent_table: ["id"] },
    }),
  });
}

describe("ObjectManager — divergent primary sources", () => {
  test("every CRUD verb refuses instead of binding the inherited table", async () => {
    const root = await loadClean(DIVERGENT_BOTH_WRITABLE);
    expectBothPrimariesSurvive(root, "ChildWeird", ["parent_table", "child_table"]);
    const om = omFor(root);
    await expect(om.findById("ChildWeird", 1)).rejects.toThrow(MetaModelError);
    await expect(om.findMany("ChildWeird")).rejects.toThrow(MetaModelError);
    await expect(om.create("ChildWeird", { label: "x" })).rejects.toThrow(MetaModelError);
    await expect(om.update("ChildWeird", 1, { label: "x" })).rejects.toThrow(MetaModelError);
    await expect(om.delete("ChildWeird", 1)).rejects.toThrow(MetaModelError);
  });

  test("the message names the object and BOTH disagreeing relations", async () => {
    const om = omFor(await loadClean(DIVERGENT_BOTH_WRITABLE));
    // Each substring separately, so a message dropping one still fails.
    await expect(om.findMany("ChildWeird")).rejects.toThrow(/ChildWeird/);
    await expect(om.findMany("ChildWeird")).rejects.toThrow(/parent_table/);
    await expect(om.findMany("ChildWeird")).rejects.toThrow(/child_table/);
  });

  test("a single primary source still reads — the refusal is about DISAGREEMENT", async () => {
    const root = await loadClean({
      "metadata.root": {
        package: "acme",
        children: [
          { "object.entity": { name: "Widget", children: [
            { "source.rdb": { "@table": "widgets" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "label" } },
            { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
          ] } },
        ],
      },
    });
    const om = new ObjectManager({
      metadata: root,
      driver: inMemoryDriver({
        seed: { widgets: [{ id: 1, label: "ok" }] },
        pkFields: { widgets: ["id"] },
      }),
    });
    expect((await om.findById("Widget", 1))?.label).toBe("ok");
  });
});
