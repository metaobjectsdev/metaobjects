import { describe, expect, it } from "bun:test";
import { TypeRegistry, type AttrSchema } from "../src/registry.js";
import { ATTR_SUBTYPE_STRING, ATTR_SUBTYPE_STRINGARRAY } from "../src/core/attr/attr-constants.js";
import { SUBTYPE_BASE } from "../src/shared/base-types.js";
import { registerCoreTypes } from "../src/core-types.js";
import { validateAttrSchema } from "../src/attr-schema-validate.js";
import { parseJson } from "../src/parser-json.js";

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

describe("TypeRegistry.registerCommonAttrs — validation integration", () => {
  /** Build a registry with core types, a common attr 'description' (string),
   *  and 'description' also declared as a per-type attr on field.string. */
  function registryWithConflict(): TypeRegistry {
    const r = new TypeRegistry();
    registerCoreTypes(r);
    // Register 'description' as a common attr.
    r.registerCommonAttrs([
      { name: "description", valueType: ATTR_SUBTYPE_STRING, required: false, description: "Free-form description." },
    ]);
    // Extend field.string with a per-type attr of the same name — this is the collision.
    r.extend("field", "string", {
      attributes: [
        { name: "description", valueType: ATTR_SUBTYPE_STRING, required: false, description: "Per-type override." },
      ],
    });
    return r;
  }

  it("validation emits ERR_PROVIDER_ATTR_CONFLICT when per-type attr collides with a common attr", () => {
    const registry = registryWithConflict();
    const doc = {
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Account",
              children: [
                { "field.string": { name: "label" } },
              ],
            },
          },
        ],
      },
    };
    const { root } = parseJson(JSON.stringify(doc), { registry });
    const { errors } = validateAttrSchema(root, registry);
    const codes = errors.map((e) => e.code);
    expect(codes).toContain("ERR_PROVIDER_ATTR_CONFLICT");
  });

  it("ERR_PROVIDER_ATTR_CONFLICT is emitted only once per (type, subType) even with multiple nodes", () => {
    const registry = registryWithConflict();
    const doc = {
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Account",
              children: [
                { "field.string": { name: "label" } },
                { "field.string": { name: "email" } },
                { "field.string": { name: "phone" } },
              ],
            },
          },
        ],
      },
    };
    const { root } = parseJson(JSON.stringify(doc), { registry });
    const { errors } = validateAttrSchema(root, registry);
    const conflictErrors = errors.filter((e) => e.code === "ERR_PROVIDER_ATTR_CONFLICT");
    expect(conflictErrors).toHaveLength(1);
  });

  it("common attrs participate in value-type checking (Check 2)", () => {
    // Register a common attr 'seeAlso' as stringarray; pass a numeric value
    // (not coercible to string[]) — the validation pass must catch the type mismatch.
    // Note: bare string IS a valid stringarray authoring form (coerced to one-element
    // array), so we use a number to force a genuine type error.
    const r = new TypeRegistry();
    registerCoreTypes(r);
    r.registerCommonAttrs([
      { name: "seeAlso", valueType: ATTR_SUBTYPE_STRINGARRAY, required: false, description: "Related items." },
    ]);
    const doc = {
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Account",
              children: [
                // @seeAlso passed as a number — not a valid stringarray value
                { "field.string": { name: "label", "@seeAlso": 42 } },
              ],
            },
          },
        ],
      },
    };
    const { root } = parseJson(JSON.stringify(doc), { registry: r });
    const { errors } = validateAttrSchema(root, r);
    const codes = errors.map((e) => e.code);
    expect(codes).toContain("ERR_BAD_ATTR_VALUE");
  });
});
