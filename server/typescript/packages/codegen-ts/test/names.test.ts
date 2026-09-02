import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaObject } from "@metaobjectsdev/metadata";
import { resolveObjectNames } from "../src/names.js";
import { CodegenError } from "../src/errors.js";

async function load(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const r = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (r.errors.length > 0) throw new Error(r.errors.map((e) => e.message).join("\n"));
  return r.root;
}
const obj = (root: Awaited<ReturnType<typeof load>>, name: string) =>
  root.children().find((c) => c.name === name) as MetaObject;

describe("resolveObjectNames", () => {
  test("carries kind and physical name, and both field names", async () => {
    const root = await load([{
      "object.entity": {
        name: "Subscriber",
        children: [
          { "source.rdb": { "@table": "subscribers" } },
          { "field.int": { name: "id" } },
          { "field.timestamp": { name: "createdAt", "@column": "created_at" } },
          { "identity.primary": { name: "id", "@fields": "id" } },
        ],
      },
    }]);
    const n = resolveObjectNames(obj(root, "Subscriber"), "snake_case");
    expect(n?.kind).toBe("table");
    expect(n?.name).toBe("subscribers");
    expect(n?.readOnly).toBe(false);
    // The collision the shape exists for: logical name != physical column.
    expect(n?.fields.createdAt).toEqual({ name: "createdAt", column: "created_at" });
  });

  test("a view-kind source is readOnly and keeps its own kind", async () => {
    // FR-024/ADR-0028 (ERR_ENTITY_PRIMARY_SOURCE_READONLY): an object.entity's PRIMARY
    // source must be writable — a read-only-kind primary source is only legal on an
    // object.projection ("a derived read model is an object.projection"). resolveObjectNames
    // itself is subtype-agnostic (it dispatches on the primary source, never the object
    // subtype — #248), so a projection exercises the readOnly branch without tripping that
    // loader rule.
    const root = await load([{
      "object.projection": {
        name: "Report",
        children: [
          { "source.rdb": { "@kind": "view", "@table": "v_report" } },
          { "field.int": { name: "id" } },
        ],
      },
    }]);
    const n = resolveObjectNames(obj(root, "Report"), "snake_case");
    expect(n?.kind).toBe("view");
    expect(n?.name).toBe("v_report");
    expect(n?.readOnly).toBe(true);
  });

  test("an object with no source resolves to undefined, not a phantom table", async () => {
    // #248: persistability derives from a declared source, never from the subtype.
    const root = await load([{
      "object.value": { name: "Money", children: [{ "field.long": { name: "cents" } }] },
    }]);
    expect(resolveObjectNames(obj(root, "Money"), "snake_case")).toBeUndefined();
  });

  test("an inherited @column resolves through extends", async () => {
    // ADR-0039: resolving accessors, so a concrete field inherits its parent's @column.
    const root = await load([
      {
        "object.entity": {
          name: "BaseThing",
          abstract: true,
          children: [{ "field.string": { name: "firstName", "@column": "given_name" } }],
        },
      },
      {
        "object.entity": {
          name: "Thing",
          extends: "BaseThing",
          children: [
            { "source.rdb": { "@table": "things" } },
            { "field.int": { name: "id" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
          ],
        },
      },
    ]);
    const n = resolveObjectNames(obj(root, "Thing"), "snake_case");
    expect(n?.fields.firstName?.column).toBe("given_name");
  });

  // Task 0 / §A6-adjacent: the divergence-refusal check added to resolveObjectNames.
  //
  // This shape puts BOTH sources on the SAME object (no extends involved), so there is
  // only ever one node with role==="primary" — the read-only view. dbTable requires
  // role==="primary" AND isWritable() on that SAME node, finds nothing (the writable
  // source here is the non-primary replica), and returns undefined — not a second,
  // disagreeing string. There is nothing for the two resolvers to disagree ABOUT: only
  // one of them is looking at a real candidate. Contrast the next test, where `extends`
  // puts two DIFFERENTLY-NAMED primary sources on one object's effective children() and
  // the two resolvers genuinely pick different nodes.
  test("a read-only primary beside a writable replica on one object loads, and resolves to the primary's own name", async () => {
    const root = await load([{
      "object.base": {
        name: "Weird",
        children: [
          { "source.rdb": { "@kind": "view", "@table": "v_weird", "@role": "primary" } },
          { "source.rdb": { "@table": "physical_weirds", "@role": "replica" } },
          { "field.int": { name: "id" } },
        ],
      },
    }]);
    const weird = obj(root, "Weird");
    // The shape this test documents: dbTable requires the SAME source to be both primary
    // AND writable, so it finds nothing here (the primary is the read-only view; the
    // writable source is the non-primary replica) — not a second, disagreeing string.
    expect(weird.dbTable).toBeUndefined();
    const n = resolveObjectNames(weird, "snake_case");
    expect(n?.name).toBe("v_weird");
    expect(n?.readOnly).toBe(true);
  });

  // The REACHABLE divergence, BOTH directions. validateSourceRoles
  // (metadata/src/persistence/source/validate-source-roles.ts) enforces "exactly one
  // primary" over ownChildren() only, never over the effective inherited set, and
  // _effectiveChildren (metadata/src/shared/meta-data.ts) shadows an own child over a super
  // child only on a (type, name) match — so two source.rdb children with DIFFERENT explicit
  // names never collide, and a parent's and a child's own primary sources both survive on
  // the child's effective children(). `load()` throws on any load error, so each fixture
  // below is proven to be metadata the loader ACCEPTS before anything else is asserted.
  //
  // Direction 1 is the one the old check could see: the inherited primary is read-only, so
  // dbTable (primary AND writable) skipped it and matched the child's. Direction 2 is the
  // one it could not: both primaries are WRITABLE, so dbTable matched the same inherited
  // node the loose scan did, the two agreed, and the guard stayed silent while every
  // generated artifact bound the parent's table over the child's own declaration.
  //
  // Neither fixture uses object.base — which the JVM cannot instantiate at all — so the
  // same two shapes are expressible in every port.
  const DIVERGENT = [
    {
      id: "read-only inherited primary",
      other: "v_parent",
      // An object.entity may not carry a read-only primary
      // (ERR_ENTITY_PRIMARY_SOURCE_READONLY), so the read-only half is an abstract
      // object.projection. An ENTITY extending one is legal — only a PROJECTION is
      // restricted to extending projections.
      children: [
        {
          "object.entity": {
            name: "Base",
            children: [
              { "source.rdb": { name: "s", "@table": "bases" } },
              { "field.long": { name: "id" } },
              { "identity.primary": { name: "pk", "@fields": "id" } },
            ],
          },
        },
        {
          "object.projection": {
            name: "ParentWeird",
            abstract: true,
            children: [
              { "source.rdb": { name: "viewSrc", "@kind": "view", "@view": "v_parent" } },
              { "field.long": { name: "id", extends: "Base.id" } },
            ],
          },
        },
        {
          "object.entity": {
            name: "ChildWeird",
            extends: "ParentWeird",
            children: [
              { "source.rdb": { name: "tableSrc", "@table": "child_table" } },
              { "identity.primary": { name: "pk", "@fields": "id" } },
            ],
          },
        },
      ],
    },
    {
      id: "both primaries writable",
      other: "parent_table",
      // Nothing exotic: two plain object.entity declarations, each naming its own table.
      children: [
        {
          "object.entity": {
            name: "ParentWeird",
            abstract: true,
            children: [
              { "source.rdb": { name: "parentSrc", "@table": "parent_table" } },
              { "field.long": { name: "id" } },
            ],
          },
        },
        {
          "object.entity": {
            name: "ChildWeird",
            extends: "ParentWeird",
            children: [
              { "source.rdb": { name: "childSrc", "@table": "child_table" } },
              { "identity.primary": { name: "pk", "@fields": "id" } },
            ],
          },
        },
      ],
    },
  ];

  for (const shape of DIVERGENT) {
    test(`a divergent primary pair is refused, naming both (${shape.id})`, async () => {
      const root = await load(shape.children);
      const child = obj(root, "ChildWeird");
      // Pin the reachability MECHANISM: both sources survive the child merge. If one
      // shadowed the other there would be no divergence and this would pass vacuously.
      const primaries = child.children()
        .filter((c) => c.type === "source" && (c as { role?: string }).role === "primary")
        .map((c) => (c as { physicalName: string }).physicalName)
        .sort();
      expect(primaries).toEqual([shape.other, "child_table"].sort());

      expect(() => resolveObjectNames(child, "snake_case")).toThrow(CodegenError);
      // Each substring asserted separately, so a message that drops one still fails.
      expect(() => resolveObjectNames(child, "snake_case")).toThrow(/ChildWeird/);
      expect(() => resolveObjectNames(child, "snake_case")).toThrow(new RegExp(shape.other));
      expect(() => resolveObjectNames(child, "snake_case")).toThrow(/child_table/);
    });
  }

  test("two primaries AGREEING on a physical name are not refused", async () => {
    // The guard is about DISAGREEMENT, not about the count. Refusing two primaries that
    // name the same relation would make it stricter than the invariant it protects.
    const root = await load([
      {
        "object.entity": {
          name: "ParentSame",
          abstract: true,
          children: [
            { "source.rdb": { name: "parentSrc", "@table": "same_table" } },
            { "field.long": { name: "id" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "ChildSame",
          extends: "ParentSame",
          children: [
            { "source.rdb": { name: "childSrc", "@table": "same_table" } },
            { "identity.primary": { name: "pk", "@fields": "id" } },
          ],
        },
      },
    ]);
    expect(resolveObjectNames(obj(root, "ChildSame"), "snake_case")?.name).toBe("same_table");
  });
});
