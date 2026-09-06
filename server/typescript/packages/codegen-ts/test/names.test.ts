import { describe, test, expect } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  isMetaSource,
  SOURCE_ROLE_PRIMARY,
  primaryRdbSource,
  type MetaObject,
  type MetaSource,
  // MetaModelError, not codegen-ts's CodegenError: the refusal moved into
  // @metaobjectsdev/metadata's primaryRdbSource so that resolveTableName,
  // resolveTableSchema and MetaObject.dbTable inherit it too — the refusal must not
  // depend on whether the `names` generator was in the run.
  MetaModelError,
} from "@metaobjectsdev/metadata";
import { resolveObjectNames, resolveSuperFragmentNames } from "../src/names.js";

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
    expect(n?.sources.primary?.kind).toBe("table");
    // `name` is the OBJECT's name; the table is under the source that declares it. Both
    // are asserted, because the change that moved the physical name out of `name` is the
    // one an adopter can adopt without a compile error.
    expect(n?.name).toBe("Subscriber");
    expect(n?.sources.primary?.table).toBe("subscribers");
    expect(n?.sources.primary?.kind).toBe("table");
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
    expect(n?.sources.primary?.kind).toBe("view");
    expect(n?.name).toBe("Report");
    expect(n?.sources.primary?.view).toBe("v_report");
    // `readOnly` is no longer carried — it was a derivation over @kind with zero
    // consumers in any port. The KIND is what the author declared, so that is what the
    // artifact mirrors, and a reader who wants read-only-ness asks it.
    expect(n?.sources.primary?.kind).toBe("view");
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

  // A single role==="primary" source that happens to be READ-ONLY, beside a non-primary
  // replica. There is exactly one primary, so there is nothing for the divergence guard
  // below to disagree ABOUT — it resolves to the primary's own name and does not throw.
  // `dbTable` (primary AND writable on the SAME node) finds nothing here and returns
  // undefined, which is why the OLD guard, comparing against it, could not have fired.
  //
  // The replica is a second READ-ONLY source, not a writable one. The writable-replica
  // spelling this test used to carry is no longer expressible on any concrete subtype:
  // an object.entity's primary must be writable and an object.projection's sources must
  // all be read-only, and the object.base it relied on is an abstract registry anchor
  // that may no longer be authored.
  test("a read-only primary beside a non-primary replica on one object loads, and resolves to the primary's own name", async () => {
    const root = await load([{
      "object.projection": {
        name: "Weird",
        children: [
          { "source.rdb": { name: "primarySrc", "@kind": "view", "@view": "v_weird", "@role": "primary" } },
          { "source.rdb": { name: "replicaSrc", "@kind": "view", "@view": "v_weird_replica", "@role": "replica" } },
          { "field.int": { name: "id" } },
        ],
      },
    }]);
    const weird = obj(root, "Weird");
    expect(weird.dbTable).toBeUndefined();
    const n = resolveObjectNames(weird, "snake_case");
    expect(n?.sources.primary?.view).toBe("v_weird");
    // `readOnly` is no longer carried — it was a derivation over @kind with zero
    // consumers in any port. The KIND is what the author declared, so that is what the
    // artifact mirrors, and a reader who wants read-only-ness asks it.
    expect(n?.sources.primary?.kind).toBe("view");
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
      // isMetaSource, not a structural cast: the exported guard is how cross-package
      // code identifies a node (CLAUDE.md), and it is what narrows the type for tsc.
      const primaries = child.children()
        .filter((c): c is MetaSource => isMetaSource(c) && c.role === SOURCE_ROLE_PRIMARY)
        .map((s) => s.physicalName)
        .sort();
      expect(primaries).toEqual([shape.other, "child_table"].sort());

      expect(() => resolveObjectNames(child, "snake_case")).toThrow(MetaModelError);
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
    expect(
      resolveObjectNames(obj(root, "ChildSame"), "snake_case")?.sources.primary?.table,
    ).toBe("same_table");
  });
});

// ---------------------------------------------------------------------------
// Inheritance — "those names classes should extend from the parent class, not
// just redo all the names."
// ---------------------------------------------------------------------------
//
// A concrete entity extending an abstract base used to restate every inherited
// column, and a TPH subtype additionally restated the base's table name. Every
// restatement is a second place one physical name is spelled — the exact defect
// <Entity>Names exists to remove, reintroduced one level up.
describe("resolveObjectNames — extends chain", () => {
  const BASE_AND_CHILD = [
    {
      "object.entity": {
        name: "BaseEntity",
        abstract: true,
        children: [
          { "field.long": { name: "id" } },
          { "field.timestamp": { name: "createdAt", "@column": "made_at" } },
        ],
      },
    },
    {
      "object.entity": {
        name: "Author",
        extends: "BaseEntity",
        children: [
          { "source.rdb": { "@table": "authors" } },
          { "field.string": { name: "email", "@column": "email_addr" } },
          { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
        ],
      },
    },
  ];

  test("an abstract base that a sourced entity extends gets its own artifact", async () => {
    const root = await load(BASE_AND_CHILD);
    // #248 intact: the base is not a database participant, so resolveObjectNames still
    // says nothing about it. The FRAGMENT resolver is what the generator reaches for once
    // it has walked up from a participant.
    expect(resolveObjectNames(obj(root, "BaseEntity"), "snake_case")).toBeUndefined();
    const n = resolveSuperFragmentNames(obj(root, "BaseEntity"), "snake_case");
    expect(n).toBeDefined();
    // It has no source, so it has no physical name — and must never acquire one.
    // The fragment carries its OWN name now (it always had one; the key just held the
    // physical name before). What it must never acquire is a SOURCE — it declares none.
    expect(n?.name).toBe("BaseEntity");
    expect(n?.sources).toEqual({});
    expect(Object.keys(n?.ownFields ?? {}).sort()).toEqual(["createdAt", "id"]);
  });

  test("the child declares ONLY its own fields, and names the base it extends", async () => {
    const root = await load(BASE_AND_CHILD);
    const n = resolveObjectNames(obj(root, "Author"), "snake_case");
    // `fields` stays RESOLVED — every consumer looks a column up by field name and must
    // find an inherited one, or it would fall back to a literal (see columnExpr).
    expect(Object.keys(n?.fields ?? {}).sort()).toEqual(["createdAt", "email", "id"]);
    // ...while what the artifact DECLARES is only what is declared here.
    expect(Object.keys(n?.ownFields ?? {}).sort()).toEqual(["email"]);
    expect(n?.superNames?.name).toBe("BaseEntity");
    // The child declares its own source, so its physical name is its own.
    expect(n?.inheritsSource).toBe(false);
    expect(n?.sources.primary?.table).toBe("authors");
  });

  test("a TPH subtype inherits the base's SOURCE, so its physical name is the base's too", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Auth",
          "@discriminator": "type",
          children: [
            { "source.rdb": { "@table": "auths" } },
            { "field.long": { name: "id" } },
            { "field.enum": { name: "type", "@values": ["Copay"] } },
            { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "CopayAuth",
          extends: "Auth",
          "@discriminatorValue": "Copay",
          children: [{ "field.long": { name: "copayAmount", "@column": "copay_cents" } }],
        },
      },
    ]);
    const n = resolveObjectNames(obj(root, "CopayAuth"), "snake_case");
    expect(n?.superNames?.name).toBe("Auth");
    // The whole point of the TPH case: the subtype restated `auths` and every base column.
    expect(n?.inheritsSource).toBe(true);
    expect(Object.keys(n?.ownFields ?? {})).toEqual(["copayAmount"]);
  });

  test("a base with no own fields and no source is NOT an artifact — there is nothing to extend", async () => {
    const root = await load([
      { "object.entity": { name: "Marker", abstract: true, children: [] } },
      {
        "object.entity": {
          name: "Thing",
          extends: "Marker",
          children: [
            { "source.rdb": { "@table": "things" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
    ]);
    expect(resolveSuperFragmentNames(obj(root, "Marker"), "snake_case")).toBeUndefined();
    expect(resolveObjectNames(obj(root, "Thing"), "snake_case")?.superNames).toBeUndefined();
  });
});


describe("two same-role sources: what refuses, and what does not", () => {
  // A model that LOADS with zero errors, that `primaryRdbSource` accepts, and that
  // `resolveObjectNames` refuses. Both halves are pinned deliberately: the divergence is
  // real and undecided, and a test that asserted only the half it liked would let the
  // other half move without anyone noticing.
  //
  // The two doors compare different things. `primaryRdbSource` compares the bare physical
  // name, for `primary` only. `sourcesOf` compares the whole resolved record — kind,
  // schema, physical name — for every role. So two primaries agreeing on `@table` and
  // disagreeing on `@schema` pass one and fail the other, and `meta gen` fails on a model
  // every other door admits.
  //
  // Named sources are what makes it reachable: unnamed ones shadow on (type, name), so
  // only one survives `children()` and there is nothing left to compare.
  const MODEL = {
    "metadata.root": {
      package: "acme",
      children: [
        {
          "object.entity": {
            name: "Base", abstract: true,
            children: [
              { "field.long": { name: "id" } },
              { "source.rdb": { name: "a", "@table": "t", "@schema": "s1", "@role": "primary" } },
            ],
          },
        },
        {
          "object.entity": {
            name: "Acct", extends: "Base",
            children: [
              { "source.rdb": { name: "b", "@table": "t", "@schema": "s2", "@role": "primary" } },
              { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
            ],
          },
        },
      ],
    },
  };

  async function acct(): Promise<MetaObject> {
    const { root, errors } = await new MetaDataLoader().load([
      new InMemoryStringSource(JSON.stringify(MODEL), { id: "two-primaries.json" }),
    ]);
    // The loader has nothing to say about it at all.
    expect(errors.map((e) => e.message)).toEqual([]);
    return root.objects().find((o) => o.name === "Acct") as MetaObject;
  }

  test("the shared authority ACCEPTS it — it compares the bare physical name", async () => {
    expect(primaryRdbSource(await acct())?.physicalName).toBe("t");
  });

  test("the names artifact REFUSES it — it compares the whole address, schema included", async () => {
    await expect(async () => resolveObjectNames(await acct()))
      .toThrow(/do not agree/);
  });
});
