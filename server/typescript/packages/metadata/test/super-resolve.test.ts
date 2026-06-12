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

describe("resolveSuperRef — bare name in same package", () => {
  it("bare name found in contextPackage", () => {
    const root = makeRoot();
    const target = makeObject("Target", "mypkg");
    root.addChild(target);

    const found = resolveSuperRef("Target", "mypkg", root);
    expect(found).toBe(target);
  });

  it("bare name falls back to root-level (no-package) node", () => {
    const root = makeRoot();
    const target = makeObject("Base", undefined); // no package
    root.addChild(target);

    const found = resolveSuperRef("Base", "some::pkg", root);
    expect(found).toBe(target);
  });

  it("bare name with empty contextPackage — falls back to root-level search", () => {
    const root = makeRoot();
    const target = makeObject("Thing", undefined);
    root.addChild(target);

    const found = resolveSuperRef("Thing", "", root);
    expect(found).toBe(target);
  });

  it("bare name not found → returns undefined", () => {
    const root = makeRoot();
    root.addChild(makeObject("Other", "mypkg"));
    const found = resolveSuperRef("Missing", "mypkg", root);
    expect(found).toBeUndefined();
  });
});

describe("resolveSuperRef — absolute path with '::' prefix", () => {
  it("resolves '::fishstore::Fish' to Fish in package fishstore", () => {
    const root = makeRoot();
    const fish = makeObject("Fish", "fishstore");
    root.addChild(fish);

    const found = resolveSuperRef("::fishstore::Fish", "other", root);
    expect(found).toBe(fish);
  });

  it("resolves deeply nested absolute ref '::a::b::c::Target'", () => {
    const root = makeRoot();
    const target = makeObject("Target", "a::b::c");
    root.addChild(target);

    const found = resolveSuperRef("::a::b::c::Target", "x::y", root);
    expect(found).toBe(target);
  });

  it("absolute ref '::pkg::Name' with empty contextPackage still resolves", () => {
    const root = makeRoot();
    const target = makeObject("Name", "pkg");
    root.addChild(target);

    const found = resolveSuperRef("::pkg::Name", "", root);
    expect(found).toBe(target);
  });

  it("non-existent absolute ref → returns undefined", () => {
    const root = makeRoot();
    const found = resolveSuperRef("::nonexistent::Thing", "x", root);
    expect(found).toBeUndefined();
  });
});

describe("resolveSuperRef — relative '..::' parent traversal", () => {
  it("resolves '..::common::id' from demo::fruitbasket up to demo::common::id", () => {
    const root = makeRoot();
    const id = makeObject("id", "demo::common");
    root.addChild(id);

    const found = resolveSuperRef("..::common::id", "demo::fruitbasket", root);
    expect(found).toBe(id);
  });

  it("relative ref from a two-level package goes up correctly", () => {
    const root = makeRoot();
    const target = makeObject("Shared", "top");
    root.addChild(target);

    // context is top::sub, going up one → top, then bare name Shared
    const found = resolveSuperRef("..::Shared", "top::sub", root);
    expect(found).toBe(target);
  });

  it("resolves from a deeply nested context with one-level up", () => {
    const root = makeRoot();
    const base = makeObject("Base", "a::b");
    root.addChild(base);
    const found = resolveSuperRef("..::Base", "a::b::c", root);
    expect(found).toBe(base);
  });

  it("relative ref that exceeds package depth returns undefined", () => {
    const root = makeRoot();
    const found = resolveSuperRef("..::..::Anything", "singlelevel", root);
    expect(found).toBeUndefined();
  });
});

describe("resolveSuperRef — multi-level relative '..::..::' traversal", () => {
  it("resolves '..::..::shared::User' from a::b::c up two levels to a::shared::User", () => {
    const root = makeRoot();
    const user = makeObject("User", "a::shared");
    root.addChild(user);

    const found = resolveSuperRef("..::..::shared::User", "a::b::c", root);
    expect(found).toBe(user);
  });

  it("resolves '..::..::Base' from a::b::c up two levels to a::Base", () => {
    const root = makeRoot();
    const base = makeObject("Base", "a");
    root.addChild(base);

    const found = resolveSuperRef("..::..::Base", "a::b::c", root);
    expect(found).toBe(base);
  });

  it("three-level relative '..::..::..::Root' from a::b::c::d goes all the way up", () => {
    const root = makeRoot();
    const rootNode = makeObject("Root", "a");
    root.addChild(rootNode);

    const found = resolveSuperRef("..::..::..::Root", "a::b::c::d", root);
    expect(found).toBe(rootNode);
  });
});

describe("resolveSuperRef — same-package shorthand", () => {
  it("same-package shorthand 'common::id' tries contextPackage prepend first", () => {
    const root = makeRoot();
    // Exists at demo::common::id
    const target = makeObject("id", "demo::common");
    root.addChild(target);

    // contextPackage is "demo"; "common::id" → try "demo::common::id" first
    const found = resolveSuperRef("common::id", "demo", root);
    expect(found).toBe(target);
  });

  it("same-package shorthand falls through to root-rooted when not in contextPackage", () => {
    const root = makeRoot();
    // Exists at common::id (root-rooted, no contextPackage prepend match)
    const target = makeObject("id", "common");
    root.addChild(target);

    // contextPackage is "other"; "common::id" → try "other::common::id" (miss), then "common::id"
    const found = resolveSuperRef("common::id", "other", root);
    expect(found).toBe(target);
  });

  it("returns undefined for completely unknown refs", () => {
    const root = makeRoot();
    const found = resolveSuperRef("Totally::Unknown::Thing", "mypkg", root);
    expect(found).toBeUndefined();
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
    expect(resolveSuperRef("::mypkg::Target", "other", root, { type: TYPE_OBJECT })).toBe(target);
  });
});
