// view-definition-completeness — proves the FR-033 externalization of the view
// provider (spec/metamodel/view.json, read via defineProviderFromData) is
// FAITHFUL and COMPLETE: a composed core registry registers, for every view
// subtype, exactly the expected attr name-set (+ valueType + required + default)
// AND the post-assigned childRules ([wildcard(attr)]) that the hand-coded
// presentation/view/view-schema.ts (currencyViewAttrs) + the old loop produced
// before the conversion.
//
// The expected table below is derived directly from the pre-FR-033
// presentation/view/view-schema.ts (currencyViewAttrs) and the old
// `[wildcard(TYPE_ATTR)]` childRules. It is the safety net the plan asks for.
//
// CRITICAL assertions: only view.currency carries an attr (@locale: string,
// optional, default "en-US"); all OTHER 12 subtypes carry NO attrs; every
// subtype's childRules == [wildcard(attr)]; views carry no dataType.

import { describe, test, expect } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreTypesProvider } from "../src/core-types.js";
import { TYPE_VIEW } from "../src/shared/base-types.js";
import { VIEW_SUBTYPES } from "../src/presentation/view/view-constants.js";

// Compose with ONLY the core-types provider — so `def.attributes` reflects
// exactly what the VIEW provider registered, not the doc-domain attrs that other
// providers add via registry.extend(). This isolates the externalization gate.
const registry = composeRegistry([coreTypesProvider]);

type ExpectedAttr = {
  valueType: string;
  required: boolean;
  default?: string;
};

// Only view.currency has an attr (@locale); every other subtype has none.
const EXPECTED: Record<string, Record<string, ExpectedAttr>> = {
  base: {},
  text: {},
  textarea: {},
  date: {},
  month: {},
  hotlink: {},
  dropdown: {},
  radio: {},
  checkbox: {},
  number: {},
  password: {},
  hidden: {},
  web: {},
  currency: {
    locale: { valueType: "string", required: false, default: "en-US" },
  },
};

describe("view provider externalization — completeness", () => {
  test("registers all 13 view subtypes", () => {
    const registered = registry.allSubTypesOf(TYPE_VIEW).sort();
    expect(registered).toEqual([...VIEW_SUBTYPES].sort());
  });

  for (const subType of VIEW_SUBTYPES) {
    test(`view.${subType} — attr name-set, valueType, required, default match the pre-FR-033 schema`, () => {
      const def = registry.find(TYPE_VIEW, subType);
      expect(def).toBeDefined();
      const expected = EXPECTED[subType]!;

      const actualNames = def!.attributes.map((a) => a.name).sort();
      expect(actualNames).toEqual(Object.keys(expected).sort());

      for (const attr of def!.attributes) {
        const exp = expected[attr.name];
        expect(exp).toBeDefined();
        expect(attr.valueType as string).toBe(exp!.valueType);
        expect(attr.required).toBe(exp!.required);
        if (exp!.default !== undefined) {
          expect(attr.default).toBe(exp!.default);
        } else {
          expect(attr.default).toBeUndefined();
        }
      }
    });

    test(`view.${subType} — childRules == [] (no any-attr wildcard)`, () => {
      // FR-033 S1-simple: view is an ATTR-ONLY type. The "any attr"
      // wildcard child rule is DROPPED — childRules are EMPTY (named attrs only,
      // no structural children, no catch-all). A misplaced structural child is
      // now ERR_CHILD_NOT_ALLOWED (see child-placement-enforcement.test.ts).
      const def = registry.find(TYPE_VIEW, subType)!;
      expect(def.childRules).toEqual([]);
    });
  }

  test("views carry no dataType", () => {
    for (const subType of VIEW_SUBTYPES) {
      const def = registry.find(TYPE_VIEW, subType)!;
      expect(def.dataType).toBeUndefined();
    }
  });
});
