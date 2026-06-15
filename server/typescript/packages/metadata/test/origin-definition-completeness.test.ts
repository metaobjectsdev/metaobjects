// origin-definition-completeness — proves the FR-033 externalization of the
// origin provider (spec/metamodel/origin.json, read via defineProviderFromData)
// is FAITHFUL and COMPLETE: a composed core registry registers, for every origin
// subtype, exactly the expected attr name-set (+ valueType + required +
// allowedValues) AND the post-assigned childRules ([wildcard(attr)]) that the
// hand-coded origin-schema.ts + the old loop produced before the conversion.
//
// The expected table below is derived directly from the pre-FR-033
// persistence/origin/origin-schema.ts (ORIGIN_ATTRS_MAP) and the old
// `[wildcard(TYPE_ATTR)]` childRules. It is the safety net the plan asks for.
//
// CRITICAL requiredness assertions: @from / @agg / @of / @via(collection) are
// REQUIRED; @via(passthrough) and @via(aggregate) are OPTIONAL.

import { describe, test, expect } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreTypesProvider } from "../src/core-types.js";
import { TYPE_ORIGIN } from "../src/shared/base-types.js";
import { ORIGIN_SUBTYPES } from "../src/persistence/origin/origin-constants.js";

// Compose with ONLY the core-types provider — so `def.attributes` reflects
// exactly what the ORIGIN provider registered, not the doc-domain attrs that
// other providers add via registry.extend(). This isolates the externalization
// gate.
const registry = composeRegistry([coreTypesProvider]);

type ExpectedAttr = {
  valueType: string;
  required: boolean;
  allowedValues?: readonly string[];
};

const EXPECTED: Record<string, Record<string, ExpectedAttr>> = {
  base: {},
  passthrough: {
    from: { valueType: "string", required: true },
    via: { valueType: "string", required: false },
  },
  aggregate: {
    agg: {
      valueType: "string",
      required: true,
      allowedValues: ["count", "sum", "avg", "min", "max"],
    },
    of: { valueType: "string", required: true },
    via: { valueType: "string", required: false },
  },
  collection: {
    via: { valueType: "string", required: true },
  },
};

describe("origin provider externalization — completeness", () => {
  test("registers all 4 origin subtypes", () => {
    const registered = registry.allSubTypesOf(TYPE_ORIGIN).sort();
    expect(registered).toEqual([...ORIGIN_SUBTYPES].sort());
  });

  for (const subType of ORIGIN_SUBTYPES) {
    test(`origin.${subType} — attr name-set, valueType, required, allowedValues match the pre-FR-033 schema`, () => {
      const def = registry.find(TYPE_ORIGIN, subType);
      expect(def).toBeDefined();
      const expected = EXPECTED[subType]!;

      const actualNames = def!.attributes.map((a) => a.name).sort();
      expect(actualNames).toEqual(Object.keys(expected).sort());

      for (const attr of def!.attributes) {
        const exp = expected[attr.name];
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

    test(`origin.${subType} — childRules == [] (no any-attr wildcard)`, () => {
      // FR-033 S1-simple: origin is an ATTR-ONLY type. The "any attr"
      // wildcard child rule is DROPPED — childRules are EMPTY (named attrs only,
      // no structural children, no catch-all). A misplaced structural child is
      // now ERR_CHILD_NOT_ALLOWED (see child-placement-enforcement.test.ts).
      const def = registry.find(TYPE_ORIGIN, subType)!;
      expect(def.childRules).toEqual([]);
    });
  }

  // CRITICAL: requiredness — @from/@agg/@of/@via(collection) required;
  // @via(passthrough)/@via(aggregate) optional.
  test("requiredness: @from/@agg/@of/@via(collection) required; @via(passthrough)/@via(aggregate) optional", () => {
    const attrOf = (subType: string, name: string) =>
      registry.find(TYPE_ORIGIN, subType)!.attributes.find((a) => a.name === name)!;

    expect(attrOf("passthrough", "from").required).toBe(true);
    expect(attrOf("passthrough", "via").required).toBe(false);
    expect(attrOf("aggregate", "agg").required).toBe(true);
    expect(attrOf("aggregate", "of").required).toBe(true);
    expect(attrOf("aggregate", "via").required).toBe(false);
    expect(attrOf("collection", "via").required).toBe(true);
  });

  test("origins carry no dataType", () => {
    for (const subType of ORIGIN_SUBTYPES) {
      const def = registry.find(TYPE_ORIGIN, subType)!;
      expect(def.dataType).toBeUndefined();
    }
  });
});
