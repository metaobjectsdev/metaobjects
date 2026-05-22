import { describe, it, expect } from "bun:test";
import { TypeId } from "../../src/registry.js";
import { MetaData } from "../../src/meta/meta-data.js";
import { MetaRoot } from "../../src/meta/meta-root.js";
import { MetaObject } from "../../src/meta/meta-object.js";
import { MetaField } from "../../src/meta/meta-field.js";
import {
  TYPE_METADATA,
  TYPE_OBJECT,
  TYPE_FIELD,
  SUBTYPE_BASE,
  OBJECT_SUBTYPE_ENTITY,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_LONG,
} from "../../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoot(): MetaRoot {
  return new MetaRoot(new TypeId(TYPE_METADATA, SUBTYPE_BASE), "root");
}

function makeObject(name: string, subType = OBJECT_SUBTYPE_ENTITY): MetaObject {
  return new MetaObject(new TypeId(TYPE_OBJECT, subType), name);
}

function makeField(name: string, subType = FIELD_SUBTYPE_STRING): MetaField {
  return new MetaField(new TypeId(TYPE_FIELD, subType), name);
}

// ---------------------------------------------------------------------------
// MetaRoot.objects()
// ---------------------------------------------------------------------------

describe("MetaRoot.objects()", () => {
  it("returns object-type children as MetaObject nodes", () => {
    const root = makeRoot();
    root.addChild(makeObject("User"));
    root.addChild(makeObject("Product"));
    root.freeze();

    const objs = root.objects();
    expect(objs).toHaveLength(2);
    expect(objs[0]!.name).toBe("User");
    expect(objs[1]!.name).toBe("Product");
  });

  it("returns an empty array when there are no object children", () => {
    const root = makeRoot();
    root.freeze();
    expect(root.objects()).toHaveLength(0);
  });

  it("excludes non-object-type children from objects()", () => {
    const root = makeRoot();
    root.addChild(makeObject("User"));
    root.addChild(makeField("sharedId", FIELD_SUBTYPE_LONG));
    root.freeze();

    const objs = root.objects();
    expect(objs).toHaveLength(1);
    expect(objs[0]!.name).toBe("User");
  });

  it("objects() returns the same array reference on a repeat call after freeze (caching)", () => {
    const root = makeRoot();
    root.addChild(makeObject("User"));
    root.freeze();
    expect(root.objects()).toBe(root.objects());
  });
});

// ---------------------------------------------------------------------------
// MetaRoot.fields()
// ---------------------------------------------------------------------------

describe("MetaRoot.fields()", () => {
  it("returns field-type children as MetaField nodes", () => {
    const root = makeRoot();
    root.addChild(makeField("sharedId", FIELD_SUBTYPE_LONG));
    root.addChild(makeField("sharedName"));
    root.freeze();

    const fields = root.fields();
    expect(fields).toHaveLength(2);
    expect(fields[0]!.name).toBe("sharedId");
    expect(fields[1]!.name).toBe("sharedName");
  });

  it("returns an empty array when there are no field children", () => {
    const root = makeRoot();
    root.addChild(makeObject("User"));
    root.freeze();
    expect(root.fields()).toHaveLength(0);
  });

  it("fields() returns the same array reference on a repeat call after freeze (caching)", () => {
    const root = makeRoot();
    root.addChild(makeField("sharedId", FIELD_SUBTYPE_LONG));
    root.freeze();
    expect(root.fields()).toBe(root.fields());
  });
});

// ---------------------------------------------------------------------------
// MetaRoot.findObject()
// ---------------------------------------------------------------------------

describe("MetaRoot.findObject()", () => {
  it("finds an object child by name", () => {
    const root = makeRoot();
    root.addChild(makeObject("User"));
    root.addChild(makeObject("Product"));
    root.freeze();

    const found = root.findObject("Product");
    expect(found).toBeDefined();
    expect(found!.name).toBe("Product");
  });

  it("returns undefined when no object with that name exists", () => {
    const root = makeRoot();
    root.addChild(makeObject("User"));
    root.freeze();

    expect(root.findObject("Missing")).toBeUndefined();
  });

  it("returns the same reference on a repeat call after freeze (caching)", () => {
    const root = makeRoot();
    root.addChild(makeObject("User"));
    root.freeze();
    expect(root.findObject("User")).toBe(root.findObject("User"));
  });

  it("returns the same undefined reference for a missing name after freeze (caching)", () => {
    const root = makeRoot();
    root.freeze();
    // Both calls should consistently return undefined (cache stores undefined too)
    expect(root.findObject("Nope")).toBeUndefined();
    expect(root.findObject("Nope")).toBeUndefined();
  });
});
