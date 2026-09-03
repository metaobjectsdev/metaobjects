import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { resolveTableSchema, resolveTableName, primaryRdbSource } from "../src/naming.js";
import { MetaModelError } from "../src/errors.js";
import { MetaObject } from "../src/core/object/meta-object.js";
import type { MetaSource } from "../src/persistence/source/meta-source.js";
import { isMetaSource } from "../src/shared/node-guards.js";
import { SOURCE_ROLE_PRIMARY } from "../src/persistence/source/source-constants.js";

async function load(doc: unknown) {
  const loader = new MetaDataLoader();
  const { root } = await loader.load([
    new InMemoryStringSource(JSON.stringify(doc), { id: "test.json" }),
  ]);
  return root;
}

describe("resolveTableSchema", () => {
  it("returns the explicit @schema attr when present on source.rdb (writable)", async () => {
    const root = await load({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "source.rdb": { "@table": "orders", "@schema": "sales" } },
              ],
            },
          },
        ],
      },
    });
    const entity = root.ownChildren().find((c) => c.name === "Order")!;
    expect(resolveTableSchema(entity)).toBe("sales");
  });

  it("returns undefined when @schema is omitted (default-aware callers decide what 'undefined' means)", async () => {
    const root = await load({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "source.rdb": { "@table": "orders" } },
              ],
            },
          },
        ],
      },
    });
    const entity = root.ownChildren().find((c) => c.name === "Order")!;
    expect(resolveTableSchema(entity)).toBeUndefined();
  });

  it("returns undefined when there is no source.rdb child at all", async () => {
    const root = await load({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [],
            },
          },
        ],
      },
    });
    const entity = root.ownChildren().find((c) => c.name === "Order")!;
    expect(resolveTableSchema(entity)).toBeUndefined();
  });

  it("reads @schema from source.rdb (@kind: view) for projection entities", async () => {
    const root = await load({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "OrderSummary",
              children: [
                { "source.rdb": { "@kind": "view", "@table": "v_order_summary", "@schema": "reporting" } },
              ],
            },
          },
        ],
      },
    });
    const entity = root.ownChildren().find((c) => c.name === "OrderSummary")!;
    expect(resolveTableSchema(entity)).toBe("reporting");
  });

  it("does not affect resolveTableName", async () => {
    const root = await load({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "source.rdb": { "@table": "orders", "@schema": "sales" } },
              ],
            },
          },
        ],
      },
    });
    const entity = root.ownChildren().find((c) => c.name === "Order")!;
    expect(resolveTableName(entity)).toBe("orders");
  });
});

// ---------------------------------------------------------------------------
// The primary-source divergence refusal.
//
// `primaryRdbSource` is THE primary-source lookup for this package, and the
// refusal lives inside it so that EVERY caller inherits it — `resolveTableName`
// (migrate-ts's expected schema, runtime-ts's ObjectManager and query builder,
// codegen-ts's entity constants and projection join map), `resolveTableSchema`,
// `MetaObject.dbTable`, and codegen-ts's `resolveObjectNames`. A refusal that
// depends on which consumer asked is not a refusal: before this moved here, the
// only caller that refused was `resolveObjectNames`, which runs only when the
// `names` generator is in the run — so `meta migrate` emitted DDL against the
// PARENT's table and `ObjectManager` read and wrote it, silently, on every run.
//
// Both shapes below load with ZERO errors, asserted first: a guard test whose
// fixture the loader would reject proves nothing. Two `@role: primary` sources
// survive on one object because `validateSourceRoles` enforces "exactly one
// primary" over ownChildren() only, and `_effectiveChildren` shadows an own
// child over a super child only on a (type, name) match — so two source.rdb
// nodes with DIFFERENT explicit names at two levels of an `extends` chain never
// collide.
// ---------------------------------------------------------------------------

async function loadClean(doc: unknown) {
  const loader = new MetaDataLoader();
  const { root, errors } = await loader.load([
    new InMemoryStringSource(JSON.stringify(doc), { id: "test.json" }),
  ]);
  expect(errors.map((e) => e.message)).toEqual([]);
  return root;
}

// Direction 1 — the inherited primary is READ-ONLY. An object.entity may not
// carry a read-only primary (ERR_ENTITY_PRIMARY_SOURCE_READONLY), so the
// read-only half is an abstract object.projection; an ENTITY extending one is
// legal (only a PROJECTION is restricted to extending projections).
const DIVERGENT_READONLY_INHERITED = {
  "metadata.root": {
    package: "acme",
    children: [
      { "object.entity": { name: "Base", children: [
        { "source.rdb": { name: "s", "@table": "bases" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
      ] } },
      { "object.projection": { name: "ParentWeird", abstract: true, children: [
        { "source.rdb": { name: "viewSrc", "@kind": "view", "@view": "v_parent" } },
        { "field.long": { name: "id", extends: "Base.id" } },
      ] } },
      { "object.entity": { name: "ChildWeird", extends: "ParentWeird", children: [
        { "source.rdb": { name: "tableSrc", "@table": "child_table" } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
      ] } },
    ],
  },
};

// Direction 2 — BOTH primaries writable. Nothing exotic: two plain
// object.entity declarations, each naming its own table. This is the direction
// a writability-based comparison could never see.
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

const DIVERGENT = [
  { id: "read-only inherited primary", doc: DIVERGENT_READONLY_INHERITED, other: "v_parent" },
  { id: "both primaries writable", doc: DIVERGENT_BOTH_WRITABLE, other: "parent_table" },
];

describe("primaryRdbSource — the divergence refusal", () => {
  for (const shape of DIVERGENT) {
    it(`refuses a divergent primary pair, naming both (${shape.id})`, async () => {
      const root = await loadClean(shape.doc);
      const child = root.ownChildren().find((c) => c.name === "ChildWeird")!;

      // Pin the reachability MECHANISM: both sources survive the child merge. If
      // one shadowed the other there would be no divergence and every assertion
      // below would pass vacuously.
      const primaries = child.children()
        .filter((c): c is MetaSource => isMetaSource(c) && c.role === SOURCE_ROLE_PRIMARY)
        .map((s) => s.physicalName)
        .sort();
      expect(primaries).toEqual([shape.other, "child_table"].sort());

      expect(() => primaryRdbSource(child)).toThrow(MetaModelError);
      // Each substring asserted separately, so a message dropping one still fails.
      expect(() => primaryRdbSource(child)).toThrow(/ChildWeird/);
      expect(() => primaryRdbSource(child)).toThrow(new RegExp(shape.other));
      expect(() => primaryRdbSource(child)).toThrow(/child_table/);
    });

    it(`every caller in this package inherits the refusal (${shape.id})`, async () => {
      const root = await loadClean(shape.doc);
      const child = root.ownChildren().find((c) => c.name === "ChildWeird")!;
      // resolveTableName is what migrate-ts's expected schema and runtime-ts's
      // ObjectManager/query builder call; resolveTableSchema and dbTable are the
      // other two doors into the same question.
      expect(() => resolveTableName(child)).toThrow(MetaModelError);
      expect(() => resolveTableSchema(child)).toThrow(MetaModelError);
      expect(() => (child as MetaObject).dbTable).toThrow(MetaModelError);
    });
  }

  it("two primaries AGREEING on a physical name are not refused", async () => {
    // The guard is about DISAGREEMENT, not about the count. Refusing two
    // primaries that name the same relation would make it stricter than the
    // invariant it protects: an object has ONE physical name, not one source.
    const root = await loadClean({
      "metadata.root": {
        package: "acme",
        children: [
          { "object.entity": { name: "ParentSame", abstract: true, children: [
            { "source.rdb": { name: "parentSrc", "@table": "same_table" } },
            { "field.long": { name: "id" } },
          ] } },
          { "object.entity": { name: "ChildSame", extends: "ParentSame", children: [
            { "source.rdb": { name: "childSrc", "@table": "same_table" } },
            { "identity.primary": { name: "pk", "@fields": "id" } },
          ] } },
        ],
      },
    });
    const child = root.ownChildren().find((c) => c.name === "ChildSame")!;
    expect(primaryRdbSource(child)?.physicalName).toBe("same_table");
    expect(resolveTableName(child)).toBe("same_table");
    expect((child as MetaObject).dbTable).toBe("same_table");
  });

  it("an object with no primary source resolves to undefined, not a refusal", async () => {
    // #248: participation in persistence derives from a declared source, never
    // from the object subtype — an object.value has none, ever.
    const root = await loadClean({
      "metadata.root": {
        package: "acme",
        children: [
          { "object.value": { name: "Money", children: [{ "field.long": { name: "cents" } }] } },
        ],
      },
    });
    const value = root.ownChildren().find((c) => c.name === "Money")!;
    expect(primaryRdbSource(value)).toBeUndefined();
    expect(resolveTableName(value)).toBe("moneys");
  });
});
