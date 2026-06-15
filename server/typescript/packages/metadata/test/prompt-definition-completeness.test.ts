// prompt-definition-completeness — proves the FR-033 S1.5-B data-driven prompt
// provider (spec/metamodel/prompt.json, read via applyProviderDefinition's
// `extends` path) lands EXACTLY the pre-S1.5 prompt/AI attrs on the right targets:
//   - @xmlText / @example / @instruction on EVERY field subtype;
//   - @enumAlias / @enumDoc / @coerceDefault / @normalize on field.enum ONLY;
//   - @normalize on object.value ONLY.
//
// Composes core + prompt so the prompt extends apply on top of the
// core-registered types (the byte-identical-canonical proof is the
// registry-conformance gate; this is the focused per-target placement assertion).

import { describe, test, expect } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreTypesProvider } from "../src/core-types.js";
import { promptProvider } from "../src/template/prompt-provider.js";
import { TYPE_FIELD, TYPE_OBJECT } from "../src/shared/base-types.js";
import { FIELD_SUBTYPES, FIELD_SUBTYPE_ENUM } from "../src/core/field/field-constants.js";
import { OBJECT_SUBTYPE_VALUE } from "../src/core/object/object-constants.js";

const registry = composeRegistry([coreTypesProvider, promptProvider]);

function attrNames(type: string, subType: string): string[] {
  return registry.find(type, subType)!.attributes.map((a) => a.name);
}

const ENUM_ONLY = ["enumAlias", "enumDoc", "coerceDefault", "normalize"] as const;

describe("prompt provider (data-driven) — attr placement", () => {
  for (const subType of FIELD_SUBTYPES) {
    test(`field.${subType} — @xmlText / @example / @instruction present`, () => {
      const names = attrNames(TYPE_FIELD, subType);
      expect(names).toContain("xmlText");
      expect(names).toContain("example");
      expect(names).toContain("instruction");
    });
  }

  test("the tolerant-extract overlays are on field.enum ONLY", () => {
    const enumNames = attrNames(TYPE_FIELD, FIELD_SUBTYPE_ENUM);
    for (const expected of ENUM_ONLY) {
      expect(enumNames).toContain(expected);
    }
    for (const subType of FIELD_SUBTYPES) {
      if (subType === FIELD_SUBTYPE_ENUM) continue;
      const names = attrNames(TYPE_FIELD, subType);
      for (const overlay of ENUM_ONLY) {
        expect(names).not.toContain(overlay);
      }
    }
  });

  test("@normalize is on object.value (and carries the strip default + allowedValues)", () => {
    const attr = registry
      .find(TYPE_OBJECT, OBJECT_SUBTYPE_VALUE)!
      .attributes.find((a) => a.name === "normalize")!;
    expect(attr).toBeDefined();
    expect(attr.default).toBe("strip");
    expect(attr.allowedValues).toEqual(["none", "collapse", "strip"]);
  });

  test("@xmlText is the boolean XML-text-content marker", () => {
    const attr = registry
      .find(TYPE_FIELD, "string")!
      .attributes.find((a) => a.name === "xmlText")!;
    expect(attr.valueType).toBe("boolean");
    expect(attr.description).toContain("XML TEXT CONTENT");
  });
});
