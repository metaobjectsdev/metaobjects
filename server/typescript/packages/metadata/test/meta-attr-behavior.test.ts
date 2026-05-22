import { describe, it, expect } from "bun:test";
import { TypeId } from "../src/registry.js";
import { MetaAttr } from "../src/meta/meta-attr.js";
import { StringArrayAttr } from "../src/meta/meta-attr-stringarray.js";
import { FilterAttr } from "../src/meta/meta-attr-filter.js";
import { PropertiesAttr } from "../src/meta/meta-attr-properties.js";
import {
  TYPE_ATTR,
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_INT,
  ATTR_SUBTYPE_BOOLEAN,
  ATTR_SUBTYPE_STRINGARRAY,
  ATTR_SUBTYPE_FILTER,
  ATTR_SUBTYPE_PROPERTIES,
} from "../src/index.js";
import {
  DATA_TYPE_STRING,
  DATA_TYPE_INT,
  DATA_TYPE_BOOLEAN,
  DATA_TYPE_OBJECT,
} from "../src/data-type.js";

function attr(subType: string, name = "a"): MetaAttr {
  return new MetaAttr(new TypeId(TYPE_ATTR, subType), name);
}

describe("MetaAttr.dataType resolves by subtype (no central map)", () => {
  it("string → DATA_TYPE_STRING", () => {
    expect(attr(ATTR_SUBTYPE_STRING).dataType).toBe(DATA_TYPE_STRING);
  });
  it("int → DATA_TYPE_INT", () => {
    expect(attr(ATTR_SUBTYPE_INT).dataType).toBe(DATA_TYPE_INT);
  });
  it("boolean → DATA_TYPE_BOOLEAN", () => {
    expect(attr(ATTR_SUBTYPE_BOOLEAN).dataType).toBe(DATA_TYPE_BOOLEAN);
  });
  it("filter / properties → DATA_TYPE_OBJECT (via subclasses)", () => {
    expect(new FilterAttr(new TypeId(TYPE_ATTR, ATTR_SUBTYPE_FILTER), "f").dataType).toBe(DATA_TYPE_OBJECT);
    expect(new PropertiesAttr(new TypeId(TYPE_ATTR, ATTR_SUBTYPE_PROPERTIES), "p").dataType).toBe(DATA_TYPE_OBJECT);
  });
});

describe("MetaAttr.coerce", () => {
  it("int subtype coerces a numeric string to a number", () => {
    expect(attr(ATTR_SUBTYPE_INT).coerce("42")).toBe(42);
  });
  it("boolean subtype coerces 'true' to true", () => {
    expect(attr(ATTR_SUBTYPE_BOOLEAN).coerce("true")).toBe(true);
  });
  it("string subtype keeps a string", () => {
    expect(attr(ATTR_SUBTYPE_STRING).coerce("hi")).toBe("hi");
  });
});

describe("StringArrayAttr", () => {
  it("dataType is string", () => {
    expect(new StringArrayAttr(new TypeId(TYPE_ATTR, ATTR_SUBTYPE_STRINGARRAY), "fields").dataType).toBe(DATA_TYPE_STRING);
  });
  it("coerce wraps a bare string into a one-element array", () => {
    const a = new StringArrayAttr(new TypeId(TYPE_ATTR, ATTR_SUBTYPE_STRINGARRAY), "fields");
    expect(a.coerce("id")).toEqual(["id"]);
  });
  it("coerce leaves an array unchanged", () => {
    const a = new StringArrayAttr(new TypeId(TYPE_ATTR, ATTR_SUBTYPE_STRINGARRAY), "fields");
    expect(a.coerce(["id", "createdAt"])).toEqual(["id", "createdAt"]);
  });
  it("validateValue rejects a non-array (bare string already coerced)", () => {
    const a = new StringArrayAttr(new TypeId(TYPE_ATTR, ATTR_SUBTYPE_STRINGARRAY), "fields");
    expect(a.validateValue("id").length).toBeGreaterThan(0);
    expect(a.validateValue(["id"]).length).toBe(0);
  });
});

describe("FilterAttr", () => {
  const f = () => new FilterAttr(new TypeId(TYPE_ATTR, ATTR_SUBTYPE_FILTER), "filter");
  it("desugars scalar → eq, array → in, null → isNull", () => {
    expect(f().desugar({ subscribed: true })).toEqual({ subscribed: { eq: true } });
    expect(f().desugar({ status: ["a", "b"] })).toEqual({ status: { in: ["a", "b"] } });
    expect(f().desugar({ deletedAt: null })).toEqual({ deletedAt: { isNull: true } });
  });
  it("leaves an explicit op clause unchanged", () => {
    expect(f().desugar({ status: { like: "a%" } })).toEqual({ status: { like: "a%" } });
  });
  it("recurses into or/and composition", () => {
    expect(f().desugar({ or: [{ a: 1 }, { b: 2 }] })).toEqual({ or: [{ a: { eq: 1 } }, { b: { eq: 2 } }] });
  });
  it("validateValue accepts an object, rejects a string", () => {
    expect(f().validateValue({ a: { eq: 1 } }).length).toBe(0);
    expect(f().validateValue("oops" as unknown as Record<string, never>).length).toBeGreaterThan(0);
  });
});

describe("PropertiesAttr", () => {
  const p = () => new PropertiesAttr(new TypeId(TYPE_ATTR, ATTR_SUBTYPE_PROPERTIES), "config");
  it("validateValue accepts an object, rejects an array", () => {
    expect(p().validateValue({ owner: "growth" }).length).toBe(0);
    expect(p().validateValue(["a"]).length).toBeGreaterThan(0);
  });
  it("desugar is identity", () => {
    expect(p().desugar({ owner: "growth" })).toEqual({ owner: "growth" });
  });
});

import { MetaField } from "../src/meta/meta-field.js";
import {
  TYPE_FIELD,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_BOOLEAN,
} from "../src/index.js";
import { DATA_TYPE_LONG } from "../src/data-type.js";

describe("MetaField.dataType resolves by subtype (no central map)", () => {
  it("int → DATA_TYPE_INT, currency → DATA_TYPE_LONG, string → DATA_TYPE_STRING", () => {
    expect(new MetaField(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_INT), "n").dataType).toBe(DATA_TYPE_INT);
    expect(new MetaField(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_CURRENCY), "c").dataType).toBe(DATA_TYPE_LONG);
    expect(new MetaField(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "s").dataType).toBe(DATA_TYPE_STRING);
  });
  it("coerce honors the field subtype", () => {
    expect(new MetaField(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_INT), "n").coerce("7")).toBe(7);
    expect(new MetaField(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_BOOLEAN), "b").coerce("true")).toBe(true);
  });
});
