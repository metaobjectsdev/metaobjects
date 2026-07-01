// identity-definition-completeness — proves the FR-033 externalization of the
// identity provider (spec/metamodel/identity.json, read via
// defineProviderFromData) is FAITHFUL and COMPLETE: a composed core registry
// registers, for every identity subtype, exactly the expected attr name-set
// (+ valueType + isArray + required + allowedValues) AND the post-assigned
// childRules that the hand-coded identity-schema.ts + the old loop produced
// before the conversion.
//
// Task 2 update: identity.secondary no longer declares @unique (removed in the
// index.lookup design). `identity.secondary` now always means "unique constraint"
// and `index.lookup` is the non-unique query-performance index.

import { describe, test, expect } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreTypesProvider } from "../src/core-types.js";
import { TYPE_IDENTITY } from "../src/shared/base-types.js";
import { IDENTITY_SUBTYPES } from "../src/core/identity/identity-constants.js";

// Compose with ONLY the core-types provider — so `def.attributes` reflects
// exactly what the IDENTITY provider registered, not the doc-domain attrs that
// other providers add via registry.extend(). This isolates the externalization
// gate.
const registry = composeRegistry([coreTypesProvider]);

type ExpectedAttr = {
  valueType: string;
  required: boolean;
  isArray?: boolean;
  allowedValues?: readonly string[];
};

/** @fields shared by all three subtypes — string, isArray, required. */
const FIELDS: ExpectedAttr = { valueType: "string", required: true, isArray: true };

const EXPECTED: Record<string, Record<string, ExpectedAttr>> = {
  primary: {
    fields: FIELDS,
    generation: {
      valueType: "string",
      required: false,
      allowedValues: ["increment", "uuid", "assigned"],
    },
  },
  secondary: {
    fields: FIELDS,
    // @unique removed — identity.secondary always means unique constraint.
    // @orders / @where / @expr / @using are physical RDB attrs contributed by
    // the db provider (registry.extend), NOT core — absent from core-only registry.
  },
  reference: {
    fields: FIELDS,
    references: { valueType: "string", required: true },
    enforce: { valueType: "boolean", required: false },
    // NOTE: @constraintName is a physical RDB attr contributed by the db provider,
    // NOT core — absent from this core-only registry.
  },
};

describe("identity provider externalization — completeness", () => {
  test("registers all 3 identity subtypes", () => {
    const registered = registry.allSubTypesOf(TYPE_IDENTITY).sort();
    expect(registered).toEqual([...IDENTITY_SUBTYPES].sort());
  });

  for (const subType of IDENTITY_SUBTYPES) {
    test(`identity.${subType} — attr name-set, valueType, isArray, required, allowedValues match the pre-FR-033 schema`, () => {
      const def = registry.find(TYPE_IDENTITY, subType);
      expect(def).toBeDefined();
      const expected = EXPECTED[subType]!;

      const actualNames = def!.attributes.map((a) => a.name).sort();
      expect(actualNames).toEqual(Object.keys(expected).sort());

      for (const attr of def!.attributes) {
        const exp = expected[attr.name];
        expect(exp).toBeDefined();
        expect(attr.valueType as string).toBe(exp!.valueType);
        expect(attr.required).toBe(exp!.required);
        expect(Boolean(attr.isArray)).toBe(Boolean(exp!.isArray));
        if (exp!.allowedValues) {
          expect(attr.allowedValues).toEqual(exp!.allowedValues);
        } else {
          expect(attr.allowedValues).toBeUndefined();
        }
      }
    });

    test(`identity.${subType} — childRules == [] (no any-attr wildcard)`, () => {
      // FR-033 S1-simple: identity is an ATTR-ONLY type. The "any attr"
      // wildcard child rule is DROPPED — childRules are EMPTY (named attrs only,
      // no structural children, no catch-all). A misplaced structural child is
      // now ERR_CHILD_NOT_ALLOWED (see child-placement-enforcement.test.ts).
      const def = registry.find(TYPE_IDENTITY, subType)!;
      expect(def.childRules).toEqual([]);
    });
  }

  test("identities carry no dataType", () => {
    for (const subType of IDENTITY_SUBTYPES) {
      const def = registry.find(TYPE_IDENTITY, subType)!;
      expect(def.dataType).toBeUndefined();
    }
  });
});
