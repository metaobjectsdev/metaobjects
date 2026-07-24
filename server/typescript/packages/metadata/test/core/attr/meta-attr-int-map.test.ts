// attr.intMap — a generic object-shaped attr whose values must all be
// integers (e.g. field.enum's future @intValueMap). Shape-only validation;
// a consumer's own semantic rules (key-set membership, uniqueness) are
// layered by that consumer, not here.

import { describe, test, expect } from "bun:test";
import { TypeId } from "../../../src/registry.js";
import { IntMapAttr } from "../../../src/core/attr/meta-attr-int-map.js";
import { TYPE_ATTR, ATTR_SUBTYPE_INT_MAP } from "../../../src/index.js";
import { type AttrValue } from "../../../src/shared/meta-data.js";

function intMapAttr(name = "intValueMap"): IntMapAttr {
  return new IntMapAttr(new TypeId(TYPE_ATTR, ATTR_SUBTYPE_INT_MAP), name);
}

describe("IntMapAttr", () => {
  test("accepts a plain object with integer values", () => {
    const attr = intMapAttr();
    expect(attr.validateValue({ DRAFT: 0, PUBLISHED: 5 })).toEqual([]);
  });

  test("rejects a non-object value", () => {
    const attr = intMapAttr();
    const errors = attr.validateValue("not-an-object" as unknown as AttrValue);
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toContain("must be of type 'intMap'");
  });

  test("rejects an array value", () => {
    const attr = intMapAttr();
    const errors = attr.validateValue([0, 1] as unknown as AttrValue);
    expect(errors.length).toBe(1);
  });

  test("rejects a non-integer value", () => {
    const attr = intMapAttr();
    const errors = attr.validateValue({ DRAFT: "0" });
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toContain("DRAFT");
  });

  test("rejects a float value", () => {
    const attr = intMapAttr();
    const errors = attr.validateValue({ DRAFT: 0.5 });
    expect(errors.length).toBe(1);
  });
});
