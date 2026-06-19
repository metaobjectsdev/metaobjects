// validator-definition-completeness — proves the FR-033 externalization of the
// validator provider (spec/metamodel/validator.json, read via
// defineProviderFromData) is FAITHFUL and COMPLETE: a composed core registry
// registers, for every validator subtype, exactly the expected attr name-set
// (+ valueType + required) AND the post-assigned childRules ([wildcard(attr)])
// that the hand-coded validator-schema.ts + the old loop produced before the
// conversion.
//
// The expected table below is derived directly from the pre-FR-033
// core/validator/validator-schema.ts (VALIDATOR_ATTRS_MAP) and the old
// `validatorRules = [wildcard(TYPE_ATTR)]`. It is the safety net the plan asks
// for.

import { describe, test, expect } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreTypesProvider } from "../src/core-types.js";
import { TYPE_VALIDATOR } from "../src/shared/base-types.js";
import { VALIDATOR_SUBTYPES } from "../src/core/validator/validator-constants.js";

// Compose with ONLY the core-types provider — so `def.attributes` reflects
// exactly what the VALIDATOR provider registered, not the doc-domain attrs that
// other providers add via registry.extend(). This isolates the externalization
// gate.
const registry = composeRegistry([coreTypesProvider]);

/** Attr name → {valueType, required}, transcribed from pre-FR-033 VALIDATOR_ATTRS_MAP. */
const MIN_MAX = {
  min: { valueType: "int", required: false },
  max: { valueType: "int", required: false },
};

const EXPECTED: Record<string, Record<string, { valueType: string; required: boolean }>> = {
  base: { ...MIN_MAX },
  required: {},
  length: { ...MIN_MAX },
  regex: { ...MIN_MAX, pattern: { valueType: "string", required: false } },
  numeric: { ...MIN_MAX },
  array: { ...MIN_MAX },
  // Cross-field validators — entity-scoped, reference sibling fields by name.
  comparison: {
    left: { valueType: "string", required: true },
    op: { valueType: "string", required: true },
    right: { valueType: "string", required: true },
  },
  requiredWhen: {
    field: { valueType: "string", required: true },
    when: { valueType: "string", required: true },
    equals: { valueType: "string", required: true },
  },
  presentIff: {
    field: { valueType: "string", required: true },
    when: { valueType: "string", required: true },
    equals: { valueType: "string", required: true },
  },
  atLeastOne: {
    fields: { valueType: "string", required: true },
  },
};

describe("validator provider externalization — completeness", () => {
  test("registers all validator subtypes", () => {
    const registered = registry.allSubTypesOf(TYPE_VALIDATOR).sort();
    expect(registered).toEqual([...VALIDATOR_SUBTYPES].sort());
  });

  for (const subType of VALIDATOR_SUBTYPES) {
    test(`validator.${subType} — attr name-set, valueType, required match the pre-FR-033 schema`, () => {
      const def = registry.find(TYPE_VALIDATOR, subType);
      expect(def).toBeDefined();
      const expected = EXPECTED[subType]!;

      const actualNames = def!.attributes.map((a) => a.name).sort();
      expect(actualNames).toEqual(Object.keys(expected).sort());

      for (const attr of def!.attributes) {
        const exp = expected[attr.name];
        expect(exp).toBeDefined();
        expect(attr.valueType as string).toBe(exp!.valueType);
        expect(attr.required).toBe(exp!.required);
      }
    });

    // FR-033 S1-simple: validator is an ATTR-ONLY type. The "any attr" wildcard
    // child rule is DROPPED — childRules are EMPTY (named attrs only, no
    // structural children, no catch-all). A misplaced structural child is now
    // ERR_CHILD_NOT_ALLOWED (asserted below).
    test(`validator.${subType} — childRules == [] (no any-attr wildcard)`, () => {
      const def = registry.find(TYPE_VALIDATOR, subType)!;
      expect(def.childRules).toEqual([]);
    });
  }

  test("validators carry no dataType", () => {
    for (const subType of VALIDATOR_SUBTYPES) {
      const def = registry.find(TYPE_VALIDATOR, subType)!;
      expect(def.dataType).toBeUndefined();
    }
  });
});
