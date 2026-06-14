// relationship-definition-completeness — proves the FR-033 externalization of the
// relationship provider (spec/metamodel/relationship.json, read via
// defineProviderFromData) is FAITHFUL and COMPLETE: a composed core registry
// registers, for every relationship subtype, exactly the expected attr name-set
// (+ valueType + required + allowedValues) AND the post-assigned childRules
// ([wildcard(attr)]) that the hand-coded relationship-schema.ts (relationshipAttrs)
// + the old loop produced before the conversion.
//
// The expected table below is derived directly from the pre-FR-033
// core/relationship/relationship-schema.ts (relationshipAttrs — all 4 subtypes
// shared the same 7 attrs) and the old `[wildcard(TYPE_ATTR)]` childRules. It is
// the safety net the plan asks for.

import { describe, test, expect } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreTypesProvider } from "../src/core-types.js";
import { TYPE_RELATIONSHIP, TYPE_ATTR } from "../src/shared/base-types.js";
import { RELATIONSHIP_SUBTYPES } from "../src/core/relationship/relationship-constants.js";
import { CHILD_RULE_WILDCARD } from "../src/shared/structural.js";

// Compose with ONLY the core-types provider — so `def.attributes` reflects
// exactly what the RELATIONSHIP provider registered, not the doc-domain attrs
// that other providers add via registry.extend(). This isolates the
// externalization gate.
const registry = composeRegistry([coreTypesProvider]);

type ExpectedAttr = {
  valueType: string;
  required: boolean;
  allowedValues?: readonly string[];
};

// All 4 relationship subtypes share the SAME 7 attrs (the pre-conversion
// relationshipAttrs). @onDelete / @onUpdate carry the referential-action enum;
// the rest are open strings / a boolean.
const REFERENTIAL_ACTIONS = ["cascade", "set-null", "restrict", "no-action"] as const;
const SHARED: Record<string, ExpectedAttr> = {
  cardinality: { valueType: "string", required: false },
  objectRef: { valueType: "string", required: false },
  through: { valueType: "string", required: false },
  sourceRefField: { valueType: "string", required: false },
  symmetric: { valueType: "boolean", required: false },
  onDelete: { valueType: "string", required: false, allowedValues: REFERENTIAL_ACTIONS },
  onUpdate: { valueType: "string", required: false, allowedValues: REFERENTIAL_ACTIONS },
};

describe("relationship provider externalization — completeness", () => {
  test("registers all 4 relationship subtypes", () => {
    const registered = registry.allSubTypesOf(TYPE_RELATIONSHIP).sort();
    expect(registered).toEqual([...RELATIONSHIP_SUBTYPES].sort());
  });

  for (const subType of RELATIONSHIP_SUBTYPES) {
    test(`relationship.${subType} — attr name-set, valueType, required, allowedValues match the pre-FR-033 schema`, () => {
      const def = registry.find(TYPE_RELATIONSHIP, subType);
      expect(def).toBeDefined();

      const actualNames = def!.attributes.map((a) => a.name).sort();
      expect(actualNames).toEqual(Object.keys(SHARED).sort());

      for (const attr of def!.attributes) {
        const exp = SHARED[attr.name];
        expect(exp).toBeDefined();
        expect(attr.valueType as string).toBe(exp!.valueType);
        expect(attr.required).toBe(exp!.required);
        if (exp!.allowedValues) {
          expect(attr.allowedValues).toEqual(exp!.allowedValues);
        } else {
          expect(attr.allowedValues).toBeUndefined();
        }
      }
    });

    test(`relationship.${subType} — childRules == [wildcard(attr)]`, () => {
      const def = registry.find(TYPE_RELATIONSHIP, subType)!;
      expect(def.childRules).toEqual([
        {
          childType: TYPE_ATTR,
          childSubType: CHILD_RULE_WILDCARD,
          childName: CHILD_RULE_WILDCARD,
        },
      ]);
    });
  }

  test("relationships carry no dataType", () => {
    for (const subType of RELATIONSHIP_SUBTYPES) {
      const def = registry.find(TYPE_RELATIONSHIP, subType)!;
      expect(def.dataType).toBeUndefined();
    }
  });
});
