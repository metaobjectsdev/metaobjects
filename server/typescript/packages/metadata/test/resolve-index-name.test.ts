// The ONE resolver for an index's database name, and the gate that makes it one.
//
// An `identity.secondary` and an `index.lookup` have no `@column`-style physical
// spelling: the database name IS the node's metamodel name. That sounds like there is
// nothing to resolve — and it is exactly why the name ended up spelled independently in
// three places (`codegen-ts/src/templates/drizzle-schema.ts`, `migrate-ts/src/
// expected-schema.ts` twice, and `KotlinExposedTableGenerator.kt`), agreeing only by
// coincidence. `fdb4118f1` is what a coincidence looks like when it lapses: codegen had
// been emitting `idx_<table>_<col>` against migrate's `identity.name`, so the index in
// the database was never the one the generated code declared.
//
// So this function's worth is not its body. It is being the single door: the JVM's
// package-prefix strip, an empty-name refusal, and any future physical-name attribute
// all live in one place instead of three that must be kept in step by hand.
import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { resolveIndexName } from "../src/naming.js";
import { MetaModelError } from "../src/errors.js";
import { MetaObject } from "../src/core/object/meta-object.js";

async function load(doc: unknown) {
  const loader = new MetaDataLoader({ strict: true });
  const { root, errors } = await loader.load([
    new InMemoryStringSource(JSON.stringify(doc), { id: "test.json" }),
  ]);
  expect(errors.map((e) => e.message)).toEqual([]);
  return root;
}

const model = (indexChildren: unknown[]) => ({
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "Customer",
          children: [
            { "source.rdb": { "@table": "customers" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "email" } },
            { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
            ...indexChildren,
          ],
        },
      },
    ],
  },
});

const customerOf = (root: { ownChildren(): { name: string }[] }): MetaObject =>
  root.ownChildren().find((c) => c.name === "Customer") as unknown as MetaObject;

describe("resolveIndexName", () => {
  it("returns an identity.secondary's own name", async () => {
    const root = await load(model([
      { "identity.secondary": { name: "uq_cust_email", "@fields": ["email"] } },
    ]));
    const [secondary] = customerOf(root).secondaryIdentities();
    expect(resolveIndexName(secondary!)).toBe("uq_cust_email");
  });

  it("returns an index.lookup's own name", async () => {
    const root = await load(model([
      { "index.lookup": { name: "ix_cust_email", "@fields": ["email"] } },
    ]));
    const [lookup] = customerOf(root).lookupIndexes();
    expect(resolveIndexName(lookup!)).toBe("ix_cust_email");
  });

  // The JVM loader package-prefixes an index name (`acme::demo::by_name`) where TS does
  // not, and `KotlinExposedTableGenerator` has always stripped it with `shortName ?: name`
  // at its own call site. Stripping HERE is what makes the two ports' answer the same
  // function rather than the same habit; on TS input it is a no-op, which is the point —
  // the rule holds without a per-port branch.
  it("strips a package qualifier, so a JVM-shaped name resolves to the database's", async () => {
    const root = await load(model([
      { "identity.secondary": { name: "uq_cust_email", "@fields": ["email"] } },
    ]));
    const [secondary] = customerOf(root).secondaryIdentities();
    // Simulate the JVM's package-qualified spelling on the same node type.
    const qualified = Object.create(Object.getPrototypeOf(secondary!));
    Object.assign(qualified, secondary!, { name: "acme::demo::uq_cust_email" });
    expect(resolveIndexName(qualified)).toBe("uq_cust_email");
  });

  // The refusal, and the asymmetry that makes it worth having.
  //
  // An `identity.secondary` with an empty name is ALREADY refused, by the loader, in
  // strict AND lax mode: identity nodes carry an FR-024 name check so a dotted `extends`
  // ref can address them. An `index.lookup` carries no such check — it is not addressable
  // that way — so an empty name there loads with ZERO errors in both modes and reaches
  // the emitters, which produce `index("")`: SQL no engine accepts, from a model that
  // passed every gate.
  //
  // So the gap is real and it is exactly one node type wide. Refusing at the shared door
  // covers codegen and migrate at once, and does it without touching the byte-gated
  // registry `rules` prose a loader-side fix would need. Both arms are asserted, because
  // "the loader already handles it" is the belief that would delete this refusal.
  it("is unreachable for an empty identity.secondary name — the loader refuses it first", async () => {
    const loader = new MetaDataLoader({ strict: true });
    const { errors } = await loader.load([
      new InMemoryStringSource(JSON.stringify(model([
        { "identity.secondary": { name: "", "@fields": ["email"] } },
      ])), { id: "test.json" }),
    ]);
    expect(errors.map((e) => e.message).join("\n")).toContain("identity.secondary");
  });

  it("refuses an empty index.lookup name, which the loader accepts", async () => {
    const root = await load(model([
      { "index.lookup": { name: "", "@fields": ["email"] } },
    ]));
    const [lookup] = customerOf(root).lookupIndexes();
    // Teeth: the load above asserts zero errors, so this documents that the node really
    // does arrive here with an empty name rather than having been rejected upstream.
    expect(lookup!.name).toBe("");
    expect(() => resolveIndexName(lookup!)).toThrow(MetaModelError);
    // The message must name the node kind, or a project with many indexes gets a refusal
    // it cannot act on.
    expect(() => resolveIndexName(lookup!)).toThrow(/index\.lookup/);
  });
});
