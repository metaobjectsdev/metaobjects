import { describe, it, expect } from "bun:test";
import { TypeId } from "../src/registry.js";
import { MetaObject } from "../src/meta/meta-object.js";
import { MetaAttr } from "../src/meta/meta-attr.js";
import { StringArrayAttr } from "../src/meta/meta-attr-stringarray.js";
import {
  TYPE_OBJECT,
  OBJECT_SUBTYPE_ENTITY,
  ATTR_SUBTYPE_STRINGARRAY,
} from "../src/index.js";

function obj(name = "Subscriber"): MetaObject {
  return new MetaObject(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), name);
}

describe("MetaData materialized attrs", () => {
  it("setAttr of a scalar is readable via ownAttr/attr and is a MetaAttr instance", () => {
    const o = obj();
    o.setAttr("dbTable", "subscriber_t");
    expect(o.ownAttr("dbTable")).toBe("subscriber_t");
    expect(o.attr("dbTable")).toBe("subscriber_t");
    expect(o.ownHasAttr("dbTable")).toBe(true);
    expect(o.hasAttr("dbTable")).toBe(true);
    const inst = o.ownMetaAttr("dbTable");
    expect(inst).toBeInstanceOf(MetaAttr);
    expect(inst!.value).toBe("subscriber_t");
  });

  it("ownAttrs() returns a value map, not instances", () => {
    const o = obj();
    o.setAttr("a", 1);
    o.setAttr("b", "x");
    expect([...o.ownAttrs().entries()]).toEqual([
      ["a", 1],
      ["b", "x"],
    ]);
  });

  it("ownMetaAttrs() returns instances in insertion order", () => {
    const o = obj();
    o.setAttr("a", 1);
    o.setAttr("b", "x");
    expect(o.ownMetaAttrs().map((m) => m.name)).toEqual(["a", "b"]);
  });

  it("attrs are NOT exposed as children", () => {
    const o = obj();
    o.setAttr("a", 1);
    expect(o.ownChildren().length).toBe(0);
    expect(o.children().length).toBe(0);
  });

  it("effective attrs walk the super chain, own wins", () => {
    const base = obj("Base");
    base.setAttr("shared", "from-base");
    base.setAttr("baseOnly", "b");
    const sub = obj("Sub");
    sub.setSuperResolved(base);
    sub.setAttr("shared", "from-sub");
    expect(sub.attr("shared")).toBe("from-sub");
    expect(sub.attr("baseOnly")).toBe("b");
    expect([...sub.attrs().keys()].sort()).toEqual(["baseOnly", "shared"]);
    // own-only excludes inherited
    expect(sub.ownHasAttr("baseOnly")).toBe(false);
  });

  it("setAttr of an undeclared array infers a StringArrayAttr instance", () => {
    const o = obj();
    o.setAttr("fields", ["id"]);
    expect(o.ownMetaAttr("fields")).toBeInstanceOf(StringArrayAttr);
    expect(o.ownAttr("fields")).toEqual(["id"]);
  });
});
