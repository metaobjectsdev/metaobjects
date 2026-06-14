// layout-definition-completeness — proves the FR-033 externalization of the
// layout provider (spec/metamodel/layout.json, read via defineProviderFromData)
// is FAITHFUL and COMPLETE: a composed core registry registers, for every layout
// subtype, exactly the expected attr name-set (+ valueType + isArray + required +
// allowedValues) AND the post-assigned childRules ([wildcard(attr)]) that the
// hand-coded layout-schema.ts (dataGridLayoutAttrs) + the old loop produced
// before the conversion.
//
// The expected table below is derived directly from the pre-FR-033
// presentation/layout/layout-schema.ts (dataGridLayoutAttrs) and the old
// `[wildcard(TYPE_ATTR)]` childRules. It is the safety net the plan asks for.
//
// CRITICAL assertions: @filter carries valueType "filter"; @columns is
// isArray:true; @defaultSortOrder carries allowedValues ["asc","desc"]; base
// carries NO attrs; layouts carry no dataType.

import { describe, test, expect } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreTypesProvider } from "../src/core-types.js";
import { TYPE_LAYOUT } from "../src/shared/base-types.js";
import { LAYOUT_SUBTYPES } from "../src/presentation/layout/layout-constants.js";

// Compose with ONLY the core-types provider — so `def.attributes` reflects
// exactly what the LAYOUT provider registered, not the doc-domain attrs that
// other providers add via registry.extend(). This isolates the externalization
// gate.
const registry = composeRegistry([coreTypesProvider]);

type ExpectedAttr = {
  valueType: string;
  isArray: boolean;
  required: boolean;
  allowedValues?: readonly string[];
};

const EXPECTED: Record<string, Record<string, ExpectedAttr>> = {
  base: {},
  dataGrid: {
    pageSize: { valueType: "int", isArray: false, required: false },
    defaultSortField: { valueType: "string", isArray: false, required: false },
    defaultSortOrder: {
      valueType: "string",
      isArray: false,
      required: false,
      allowedValues: ["asc", "desc"],
    },
    filterable: { valueType: "boolean", isArray: false, required: false },
    filter: { valueType: "filter", isArray: false, required: false },
    columns: { valueType: "string", isArray: true, required: false },
  },
};

describe("layout provider externalization — completeness", () => {
  test("registers all 2 layout subtypes", () => {
    const registered = registry.allSubTypesOf(TYPE_LAYOUT).sort();
    expect(registered).toEqual([...LAYOUT_SUBTYPES].sort());
  });

  for (const subType of LAYOUT_SUBTYPES) {
    test(`layout.${subType} — attr name-set, valueType, isArray, required, allowedValues match the pre-FR-033 schema`, () => {
      const def = registry.find(TYPE_LAYOUT, subType);
      expect(def).toBeDefined();
      const expected = EXPECTED[subType]!;

      const actualNames = def!.attributes.map((a) => a.name).sort();
      expect(actualNames).toEqual(Object.keys(expected).sort());

      for (const attr of def!.attributes) {
        const exp = expected[attr.name];
        expect(exp).toBeDefined();
        expect(attr.valueType as string).toBe(exp!.valueType);
        expect(attr.isArray ?? false).toBe(exp!.isArray);
        expect(attr.required).toBe(exp!.required);
        if (exp!.allowedValues) {
          expect(attr.allowedValues).toEqual(exp!.allowedValues);
        } else {
          expect(attr.allowedValues).toBeUndefined();
        }
      }
    });

    test(`layout.${subType} — childRules == [] (no any-attr wildcard)`, () => {
      // FR-033 S1-simple: layout is an ATTR-ONLY type. The "any attr"
      // wildcard child rule is DROPPED — childRules are EMPTY (named attrs only,
      // no structural children, no catch-all). A misplaced structural child is
      // now ERR_CHILD_NOT_ALLOWED (see child-placement-enforcement.test.ts).
      const def = registry.find(TYPE_LAYOUT, subType)!;
      expect(def.childRules).toEqual([]);
    });
  }

  test("layouts carry no dataType", () => {
    for (const subType of LAYOUT_SUBTYPES) {
      const def = registry.find(TYPE_LAYOUT, subType)!;
      expect(def.dataType).toBeUndefined();
    }
  });
});
