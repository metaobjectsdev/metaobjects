import { describe, expect, it } from "bun:test";
import { TypeRegistry, type AttrSchema } from "../src/registry.js";
import { ATTR_SUBTYPE_STRING } from "../src/core/attr/attr-constants.js";
import { SUBTYPE_BASE } from "../src/shared/base-types.js";

describe("TypeRegistry.registerCommonAttrs", () => {
  it("registers a common attr accessible on getCommonAttrs()", () => {
    const r = new TypeRegistry();
    const attrs: AttrSchema[] = [
      { name: "description", valueType: ATTR_SUBTYPE_STRING, required: false, description: "Free-form description." },
    ];
    r.registerCommonAttrs(attrs);
    expect(r.getCommonAttrs().map(a => a.name)).toContain("description");
  });

  it("dedupes repeated registration of the same name", () => {
    const r = new TypeRegistry();
    const attr: AttrSchema = { name: "title", valueType: ATTR_SUBTYPE_STRING, required: false, description: "" };
    r.registerCommonAttrs([attr]);
    r.registerCommonAttrs([attr]);
    expect(r.getCommonAttrs().filter(a => a.name === "title")).toHaveLength(1);
  });

  it("throws when an attr declares valueType SUBTYPE_BASE (mirrors register/extend guard)", () => {
    const r = new TypeRegistry();
    expect(() =>
      r.registerCommonAttrs([
        { name: "bad", valueType: SUBTYPE_BASE, required: false, description: "" },
      ]),
    ).toThrow(/valueType.*"base".*not valid for attrs/i);
  });

  it("accepts attrs that omit valueType (polymorphic/untyped)", () => {
    const r = new TypeRegistry();
    expect(() =>
      r.registerCommonAttrs([{ name: "polymorphic", required: false, description: "" }]),
    ).not.toThrow();
    expect(r.getCommonAttrs().map(a => a.name)).toContain("polymorphic");
  });
});
