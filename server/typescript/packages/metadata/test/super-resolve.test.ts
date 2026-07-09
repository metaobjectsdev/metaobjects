// super-resolve.test.ts
//
// Tests for the resolveSuperRef() lookup helper.
// The post-parse multi-pass resolveSupers() walker has been deleted (Java does
// immediate resolution during parse). This file only tests the reference lookup.

import { describe, it, expect } from "bun:test";
import { MetaObject } from "../src/core/object/meta-object.js";
import { MetaField } from "../src/core/field/meta-field.js";
import { MetaIdentity } from "../src/core/identity/meta-identity.js";
import { MetaRoot } from "../src/shared/meta-root.js";
import type { MetaData } from "../src/shared/meta-data.js";
import { TypeId } from "../src/registry.js";
import { resolveSuperRef } from "../src/super-resolve.js";
import { expandRef } from "../src/naming-refs.js";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { composeRegistry } from "../src/provider.js";
import { coreTypesProvider } from "../src/core-types.js";
import { dbProvider } from "../src/persistence/db/db-provider.js";
import { canonicalSerialize } from "../src/serializer-json.js";
import {
  TYPE_METADATA,
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_IDENTITY,
  TYPE_VIEW,
  OBJECT_SUBTYPE_ENTITY,
  SUBTYPE_ROOT,
  FIELD_SUBTYPE_UUID,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_CURRENCY,
  IDENTITY_SUBTYPE_PRIMARY,
  VIEW_SUBTYPE_CURRENCY,
} from "../src/index.js";
import { MetaView } from "../src/presentation/view/meta-view.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeObject(name: string, pkg?: string): MetaData {
  const m = new MetaObject(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), name);
  if (pkg !== undefined) m.setPackage(pkg);
  return m;
}

function makeField(name: string, subType: string): MetaData {
  return new MetaField(new TypeId(TYPE_FIELD, subType), name);
}

function makeIdentity(name: string, subType: string): MetaData {
  return new MetaIdentity(new TypeId(TYPE_IDENTITY, subType), name);
}

function makeView(name: string, subType: string): MetaData {
  return new MetaView(new TypeId(TYPE_VIEW, subType), name);
}

function makeRoot(): MetaData {
  return new MetaRoot(new TypeId(TYPE_METADATA, SUBTYPE_ROOT), "__root__");
}

// ---------------------------------------------------------------------------
// resolveSuperRef — unit tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// FR-032 (ADR-0032): the absolute (`::pkg::Name`) and parent-relative
// (`..::common::id`) authoring forms are now expanded to FQN by `expandRef` at
// YAML-desugar time — they no longer survive into the tree, so the resolver no
// longer interprets them. The old prefix-resolution unit tests below were
// MIGRATED to assert `expandRef(input) → FQN` instead of resolution behavior;
// the resolver's `::`-strip / `..::`-reduce / bare-then-root-fallback branches
// are deleted in this slice (T3). The resolver keeps only pure FQN matching
// (`<P>::name` for the rare in-tree bare) + the FR-024 dotted-child traversal.
// ---------------------------------------------------------------------------

describe("resolveSuperRef — bare name in current package (no root fallback, FR-032)", () => {
  it("bare name found in contextPackage", () => {
    const root = makeRoot();
    const target = makeObject("Target", "mypkg");
    root.addChild(target);

    const found = resolveSuperRef("Target", "mypkg", root);
    expect(found).toBe(target);
  });

  it("bare name not found in the current package → returns undefined", () => {
    const root = makeRoot();
    root.addChild(makeObject("Other", "mypkg"));
    const found = resolveSuperRef("Missing", "mypkg", root);
    expect(found).toBeUndefined();
  });
});

describe("expandRef — absolute path with '::' prefix → FQN (migrated from resolver)", () => {
  it("'::fishstore::Fish' expands to 'fishstore::Fish'", () => {
    expect(expandRef("::fishstore::Fish", "other")).toBe("fishstore::Fish");
  });

  it("deeply nested absolute ref '::a::b::c::Target' → 'a::b::c::Target'", () => {
    expect(expandRef("::a::b::c::Target", "x::y")).toBe("a::b::c::Target");
  });

  it("'::pkg::Name' with empty contextPackage → 'pkg::Name'", () => {
    expect(expandRef("::pkg::Name", "")).toBe("pkg::Name");
  });
});

describe("expandRef — relative '..::' parent traversal → FQN (migrated from resolver)", () => {
  it("'..::common::id' from demo::fruitbasket → 'demo::common::id'", () => {
    expect(expandRef("..::common::id", "demo::fruitbasket")).toBe("demo::common::id");
  });

  it("'..::Shared' from top::sub → 'top::Shared'", () => {
    expect(expandRef("..::Shared", "top::sub")).toBe("top::Shared");
  });

  it("'..::Base' from a::b::c → 'a::b::Base'", () => {
    expect(expandRef("..::Base", "a::b::c")).toBe("a::b::Base");
  });

  it("'..::..::Anything' that exceeds package depth → throws", () => {
    expect(() => expandRef("..::..::Anything", "singlelevel")).toThrow();
  });
});

describe("expandRef — multi-level relative '..::..::' traversal → FQN (migrated from resolver)", () => {
  it("'..::..::shared::User' from a::b::c → 'a::shared::User'", () => {
    expect(expandRef("..::..::shared::User", "a::b::c")).toBe("a::shared::User");
  });

  it("'..::..::Base' from a::b::c → 'a::Base'", () => {
    expect(expandRef("..::..::Base", "a::b::c")).toBe("a::Base");
  });

  it("'..::..::..::Root' from a::b::c::d → 'a::Root'", () => {
    expect(expandRef("..::..::..::Root", "a::b::c::d")).toBe("a::Root");
  });
});

// ---------------------------------------------------------------------------
// FR-024 (ADR-0029) — dotted `Entity.child` refs, type-scoped resolution
// ---------------------------------------------------------------------------

describe("resolveSuperRef — dotted Entity.child refs (FR-024)", () => {
  /** Customer entity with field `id` (uuid), field `name` (string), and an
   *  identity.primary ALSO named `id` — the type-scoping disambiguation case. */
  function makeCustomer(pkg: string): { customer: MetaData; idField: MetaData; nameField: MetaData; idIdentity: MetaData } {
    const customer = makeObject("Customer", pkg);
    const idField = makeField("id", FIELD_SUBTYPE_UUID);
    const nameField = makeField("name", FIELD_SUBTYPE_STRING);
    const idIdentity = makeIdentity("id", IDENTITY_SUBTYPE_PRIMARY);
    customer.addChild(idField);
    customer.addChild(nameField);
    customer.addChild(idIdentity);
    return { customer, idField, nameField, idIdentity };
  }

  it("Customer.id (same package) resolves to the field child for a field-typed referrer", () => {
    const root = makeRoot();
    const { customer, idField } = makeCustomer("demo");
    root.addChild(customer);

    const found = resolveSuperRef("Customer.id", "demo", root, { type: TYPE_FIELD });
    expect(found).toBe(idField);
  });

  it("cross-package acme::sales::Customer.id resolves from another package", () => {
    const root = makeRoot();
    const { customer, idField } = makeCustomer("acme::sales");
    root.addChild(customer);

    const found = resolveSuperRef("acme::sales::Customer.id", "acme::api", root, { type: TYPE_FIELD });
    expect(found).toBe(idField);
  });

  it("Customer.nosuch → undefined", () => {
    const root = makeRoot();
    const { customer } = makeCustomer("demo");
    root.addChild(customer);

    const found = resolveSuperRef("Customer.nosuch", "demo", root, { type: TYPE_FIELD });
    expect(found).toBeUndefined();
  });

  it("type-scoping: a field referrer selects the FIELD `id`, an identity referrer the IDENTITY `id`", () => {
    const root = makeRoot();
    const { customer, idField, idIdentity } = makeCustomer("demo");
    root.addChild(customer);

    const asField = resolveSuperRef("Customer.id", "demo", root, { type: TYPE_FIELD });
    expect(asField).toBe(idField);

    const asIdentity = resolveSuperRef("Customer.id", "demo", root, { type: TYPE_IDENTITY });
    expect(asIdentity).toBe(idIdentity);
  });

  it("dotted ref WITHOUT a referrer scope → undefined (scope is required for the dotted branch)", () => {
    const root = makeRoot();
    const { customer } = makeCustomer("demo");
    root.addChild(customer);

    const found = resolveSuperRef("Customer.id", "demo", root);
    expect(found).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Deep traversal (`X.y.z...`): package qualifies the ROOT node only; every
  // subsequent segment traverses child names. Intermediate segments resolve by
  // UNIQUE name (cross-type collision = ambiguous = unresolved); the final
  // segment is type-scoped to the referrer.
  // -------------------------------------------------------------------------

  it("triple-nest Customer.priceCents.display resolves the field's VIEW for a view referrer", () => {
    const root = makeRoot();
    const { customer } = makeCustomer("demo");
    const price = makeField("priceCents", FIELD_SUBTYPE_CURRENCY);
    const display = makeView("display", VIEW_SUBTYPE_CURRENCY);
    price.addChild(display);
    customer.addChild(price);
    root.addChild(customer);

    const found = resolveSuperRef("Customer.priceCents.display", "demo", root, { type: TYPE_VIEW });
    expect(found).toBe(display);
  });

  it("deep traversal: missing intermediate segment → undefined", () => {
    const root = makeRoot();
    const { customer } = makeCustomer("demo");
    root.addChild(customer);

    const found = resolveSuperRef("Customer.nosuch.display", "demo", root, { type: TYPE_VIEW });
    expect(found).toBeUndefined();
  });

  it("deep traversal: AMBIGUOUS intermediate (field + identity both named 'id') → undefined", () => {
    const root = makeRoot();
    const { customer, idField } = makeCustomer("demo"); // has field `id` AND identity `id`
    const v = makeView("display", VIEW_SUBTYPE_CURRENCY);
    idField.addChild(v);
    root.addChild(customer);

    // "id" matches two children of different types → ambiguous intermediate.
    const found = resolveSuperRef("Customer.id.display", "demo", root, { type: TYPE_VIEW });
    expect(found).toBeUndefined();
  });

  it("deep traversal: final segment stays type-scoped to the referrer", () => {
    const root = makeRoot();
    const { customer } = makeCustomer("demo");
    const price = makeField("priceCents", FIELD_SUBTYPE_CURRENCY);
    const display = makeView("display", VIEW_SUBTYPE_CURRENCY);
    price.addChild(display);
    customer.addChild(price);
    root.addChild(customer);

    // A FIELD referrer must not resolve the view through the same path.
    const found = resolveSuperRef("Customer.priceCents.display", "demo", root, { type: TYPE_FIELD });
    expect(found).toBeUndefined();
  });

  it("an unresolvable dotted ref does NOT fall through to bare lookup", () => {
    const root = makeRoot();
    // A top-level abstract field `id` exists — but `Nowhere.id` must NOT find it.
    const topLevelId = makeField("id", FIELD_SUBTYPE_UUID);
    topLevelId.setPackage("demo");
    root.addChild(topLevelId);

    const found = resolveSuperRef("Nowhere.id", "demo", root, { type: TYPE_FIELD });
    expect(found).toBeUndefined();
  });

  it("dotted ref resolves children INHERITED by the owner (effective children)", () => {
    const root = makeRoot();
    const base = makeObject("BaseEntity", "demo");
    const baseId = makeField("id", FIELD_SUBTYPE_UUID);
    base.addChild(baseId);
    const customer = makeObject("Customer", "demo");
    customer.setSuperResolved(base);
    root.addChild(base);
    root.addChild(customer);

    const found = resolveSuperRef("Customer.id", "demo", root, { type: TYPE_FIELD });
    expect(found).toBe(baseId);
  });

  it("regression: dot-free refs behave exactly as before, with or without a referrer scope", () => {
    const root = makeRoot();
    const target = makeObject("Target", "mypkg");
    root.addChild(target);

    expect(resolveSuperRef("Target", "mypkg", root)).toBe(target);
    expect(resolveSuperRef("Target", "mypkg", root, { type: TYPE_OBJECT })).toBe(target);
    // FR-032: refs in the loaded tree are already FQN (the desugar/JSON-guard
    // ensured this), so the resolver matches the qualified form directly — the
    // `::`-strip branch is gone.
    expect(resolveSuperRef("mypkg::Target", "other", root, { type: TYPE_OBJECT })).toBe(target);
  });
});

describe("resolveDeferredSupers — load-order independence (#188)", () => {
  // Three docs: an abstract base declaring `id` + `pk`, an entity that INHERITS
  // them via `extends`, and a projection whose `pk`/`id` carry a dotted
  // `extends: Customer.pk` / `Customer.id` to those INHERITED members. Before
  // #188 this resolved only when the owner's file was parsed before the
  // referrer's — green under Node's readdir order, ERR_UNRESOLVED_SUPER under
  // Bun's. Resolving a corpus must be a pure function of the source SET, so
  // EVERY permutation must yield the same clean, byte-identical resolved model.
  const base = JSON.stringify({
    "metadata.root": {
      package: "acme::common",
      children: [
        {
          "object.entity": {
            name: "BaseEntity",
            abstract: true,
            children: [
              { "field.uuid": { name: "id", "@required": true } },
              { "identity.primary": { name: "pk", "@fields": ["id"] } },
            ],
          },
        },
      ],
    },
  });
  const customer = JSON.stringify({
    "metadata.root": {
      package: "acme::shop",
      children: [
        {
          "object.entity": {
            name: "Customer",
            extends: "acme::common::BaseEntity",
            children: [
              { "source.rdb": { "@table": "customers" } },
              { "field.string": { name: "name", "@required": true } },
            ],
          },
        },
      ],
    },
  });
  const view = JSON.stringify({
    "metadata.root": {
      package: "acme::shop",
      children: [
        {
          "object.projection": {
            name: "CustomerView",
            children: [
              { "source.rdb": { "@kind": "view", "@view": "v_customers" } },
              {
                "field.uuid": {
                  name: "id",
                  extends: "acme::shop::Customer.id",
                  children: [{ "origin.passthrough": { "@from": "acme::shop::Customer.id" } }],
                },
              },
              {
                "field.string": {
                  name: "name",
                  children: [{ "origin.passthrough": { "@from": "acme::shop::Customer.name" } }],
                },
              },
              {
                "identity.primary": {
                  name: "pk",
                  extends: "acme::shop::Customer.pk",
                  "@fields": ["id"],
                },
              },
            ],
          },
        },
      ],
    },
  });
  const docs: Record<string, string> = { base, customer, view };
  const names = Object.keys(docs);
  const permutations = (xs: string[]): string[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));

  async function loadInOrder(order: string[]): Promise<{ ok: boolean; model: string }> {
    const loader = new MetaDataLoader({ registry: composeRegistry([coreTypesProvider, dbProvider]), strict: true });
    const result = await loader.load(order.map((n) => new InMemoryStringSource(docs[n]!, { id: `${n}.json` })));
    if (result.errors.length) return { ok: false, model: "" };
    // The RESOLVED SEMANTIC model must be order-independent. Whole-tree
    // canonical serialization is NOT: it preserves the top-level node SEQUENCE,
    // which legitimately follows load order (base-first lists BaseEntity first;
    // view-first lists CustomerView first). So compare the order-insensitive
    // SET of each root child's canonically-serialized subtree — that captures
    // every resolved relationship (who extends what, which inherited members
    // are reachable) without pinning the top-level ordering.
    const subtrees = result.root
      .children()
      .map((c) => canonicalSerialize(c).trim())
      .sort();
    return { ok: true, model: JSON.stringify(subtrees) };
  }

  it("every permutation of the source order resolves cleanly AND produces the same resolved model", async () => {
    const results = await Promise.all(permutations(names).map(loadInOrder));
    // No permutation errors — the dotted ref to an inherited member resolves in every order.
    for (const r of results) expect(r.ok).toBe(true);
    // Every permutation yields the identical order-insensitive resolved model.
    const first = results[0]!.model;
    expect(first.length).toBeGreaterThan(2);
    for (const r of results) expect(r.model).toBe(first);
  });

  it("reports an unresolvable owner EXACTLY ONCE (no duplicate failures from on-demand recursion)", async () => {
    // An owner with an unresolvable top-level super, plus a projection whose
    // dotted `extends: Owner.pk` reaches that owner via recursion. Under the
    // on-demand resolver the owner is reachable both from the `pending` loop and
    // from the referrer's owner-recursion — the `attempted` guard must ensure it
    // is reported only ONCE (the pre-#188 single-visit walk's guarantee).
    const owner = JSON.stringify({
      "metadata.root": {
        package: "p",
        children: [
          { "object.entity": { name: "Owner", extends: "p::DoesNotExist", children: [{ "field.uuid": { name: "id" } }] } },
        ],
      },
    });
    const view = JSON.stringify({
      "metadata.root": {
        package: "p",
        children: [
          {
            "object.projection": {
              name: "V",
              children: [
                { "source.rdb": { "@kind": "view", "@view": "v" } },
                { "identity.primary": { name: "pk", extends: "p::Owner.pk", "@fields": ["id"] } },
              ],
            },
          },
        ],
      },
    });
    const loader = new MetaDataLoader({ registry: composeRegistry([coreTypesProvider, dbProvider]), strict: true });
    const result = await loader.load([
      new InMemoryStringSource(view, { id: "a.json" }),
      new InMemoryStringSource(owner, { id: "b.json" }),
    ]);
    const seen = new Map<string, number>();
    for (const e of result.errors) {
      const err = e as { code?: string; source?: { jsonPath?: string } };
      const key = `${err.code}@${err.source?.jsonPath ?? "?"}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const [key, count] of seen) expect(`${key} x${count}`).toBe(`${key} x1`);
  });
});
