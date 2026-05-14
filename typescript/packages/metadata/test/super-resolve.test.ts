// super-resolve.test.ts
//
// Tests for the resolveSuperRef() lookup helper.
// The post-parse multi-pass resolveSupers() walker has been deleted (Java does
// immediate resolution during parse). This file only tests the reference lookup.

import { describe, it, expect } from "bun:test";
import { MetaModel } from "../src/model.js";
import { TypeId } from "../src/registry.js";
import { resolveSuperRef } from "../src/super-resolve.js";
import { TYPE_OBJECT } from "../src/constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeObject(name: string, pkg?: string): MetaModel {
  const m = new MetaModel(new TypeId(TYPE_OBJECT, "simple"), name);
  if (pkg !== undefined) m.setPackage(pkg);
  return m;
}

function makeRoot(): MetaModel {
  return new MetaModel(new TypeId(TYPE_OBJECT, "root"), "__root__");
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
