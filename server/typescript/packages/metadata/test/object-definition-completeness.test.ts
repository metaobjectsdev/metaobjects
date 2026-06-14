// object-definition-completeness — proves the FR-033 externalization of the
// object provider (spec/metamodel/object.json, read via defineProviderFromData)
// is FAITHFUL and COMPLETE. Object is the most complex core provider: its attr
// set varies by subtype (object.value carries an extra @normalize) AND its
// structural childRules vary by subtype (entity co-locates templates; projection
// admits neither relationship nor template; base/value admit relationship but no
// template). This test pins BOTH dimensions, per subtype, against the
// pre-FR-033 hand-coded registration (objectAttrs + normalizeAttr + the
// objectRules/projectionRules child arrays).
//
// The per-subtype childRules assertion is the critical safety net: a mistake here
// (projection gaining relationship, entity losing template) would be a silent
// behavior change. expected-registry.json (children byte-identical) is the second
// gate.

import { describe, test, expect } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreTypesProvider } from "../src/core-types.js";
import { TYPE_OBJECT, TYPE_TEMPLATE } from "../src/shared/base-types.js";
import {
  OBJECT_SUBTYPES,
  OBJECT_SUBTYPE_ENTITY,
  OBJECT_SUBTYPE_VALUE,
  OBJECT_SUBTYPE_PROJECTION,
} from "../src/core/object/object-constants.js";
import { SUBTYPE_BASE } from "../src/shared/base-types.js";

// Compose with ONLY the core-types provider — so `def.attributes` / `childRules`
// reflect exactly what the OBJECT provider registered, not the db/doc-domain
// attrs that other providers add via registry.extend(). This isolates the gate.
const registry = composeRegistry([coreTypesProvider]);

interface ExpectedAttr {
  valueType: string | null;
  required: boolean;
  default?: string;
  allowedValues?: readonly string[];
}

// The 2 discriminator attrs every object subtype carries (objectAttrs).
const COMMON: Record<string, ExpectedAttr> = {
  discriminator: { valueType: "string", required: false },
  discriminatorValue: { valueType: "string", required: false },
};

// object.value additionally carries @normalize (was normalizeAttr).
const NORMALIZE_EXTRA: Record<string, ExpectedAttr> = {
  normalize: {
    valueType: "string",
    required: false,
    default: "strip",
    allowedValues: ["none", "collapse", "strip"],
  },
};

function expectedAttrsFor(subType: string): Record<string, ExpectedAttr> {
  return subType === OBJECT_SUBTYPE_VALUE ? { ...COMMON, ...NORMALIZE_EXTRA } : { ...COMMON };
}

// The EXACT structural childRule childType set per subtype (the critical
// safety net). objectRules carries field/identity/relationship/validator/
// layout/source/attr; projectionRules drops relationship; entity adds template.
const OBJECT_RULE_TYPES = ["field", "identity", "relationship", "validator", "layout", "source", "attr"];
const PROJECTION_RULE_TYPES = ["field", "identity", "validator", "layout", "source", "attr"];

function expectedChildTypesFor(subType: string): string[] {
  if (subType === OBJECT_SUBTYPE_ENTITY) return [...OBJECT_RULE_TYPES, TYPE_TEMPLATE];
  if (subType === OBJECT_SUBTYPE_PROJECTION) return PROJECTION_RULE_TYPES;
  // base + value
  return OBJECT_RULE_TYPES;
}

describe("object provider externalization — completeness", () => {
  test("registers all 4 object subtypes", () => {
    const registered = registry.allSubTypesOf(TYPE_OBJECT).sort();
    expect(registered).toEqual([...OBJECT_SUBTYPES].sort());
  });

  for (const subType of OBJECT_SUBTYPES) {
    test(`object.${subType} — attr name-set, valueType, required, default, allowedValues match the pre-FR-033 schema`, () => {
      const def = registry.find(TYPE_OBJECT, subType);
      expect(def).toBeDefined();
      const expected = expectedAttrsFor(subType);

      // Attr name-set is exactly the expected set.
      const actualNames = def!.attributes.map((a) => a.name).sort();
      expect(actualNames).toEqual(Object.keys(expected).sort());

      // Each attr's valueType + required (+ default + allowedValues) match.
      for (const attr of def!.attributes) {
        const exp = expected[attr.name];
        expect(exp).toBeDefined();
        expect((attr.valueType ?? null) as string | null).toBe(exp!.valueType);
        expect(attr.required).toBe(exp!.required);
        expect(attr.default ?? undefined).toEqual(exp!.default);
        expect(attr.allowedValues).toEqual(exp!.allowedValues);
      }
    });

    test(`object.${subType} — structural childRules match the EXACT per-subtype expected set`, () => {
      const def = registry.find(TYPE_OBJECT, subType)!;
      const actualTypes = def.childRules.map((r) => r.childType).sort();
      expect(actualTypes).toEqual([...expectedChildTypesFor(subType)].sort());

      // All structural rules are wildcard (subType/name = "*").
      for (const rule of def.childRules) {
        expect(rule.childSubType).toBe("*");
        expect(rule.childName).toBe("*");
      }
    });
  }

  test("only object.entity carries the template childRule", () => {
    for (const subType of OBJECT_SUBTYPES) {
      const def = registry.find(TYPE_OBJECT, subType)!;
      const hasTemplate = def.childRules.some((r) => r.childType === TYPE_TEMPLATE);
      expect(hasTemplate).toBe(subType === OBJECT_SUBTYPE_ENTITY);
    }
  });

  test("only object.projection omits the relationship childRule", () => {
    for (const subType of OBJECT_SUBTYPES) {
      const def = registry.find(TYPE_OBJECT, subType)!;
      const hasRelationship = def.childRules.some((r) => r.childType === "relationship");
      expect(hasRelationship).toBe(subType !== OBJECT_SUBTYPE_PROJECTION);
    }
  });

  test("base + value carry relationship but not template", () => {
    for (const subType of [SUBTYPE_BASE, OBJECT_SUBTYPE_VALUE]) {
      const def = registry.find(TYPE_OBJECT, subType)!;
      const types = def.childRules.map((r) => r.childType);
      expect(types).toContain("relationship");
      expect(types).not.toContain(TYPE_TEMPLATE);
    }
  });
});
