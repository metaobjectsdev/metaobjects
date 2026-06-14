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
import { coreProviders, coreTypesProvider } from "../src/core-types.js";
import { TYPE_VIEW } from "../src/shared/base-types.js";
import { VIEW_SUBTYPES } from "../src/presentation/view/view-constants.js";

// FR-033 S2: view.currency's @locale type attr was re-homed OUT of core into the
// UI concern provider (spec/metamodel/ui.json → uiProvider, applied via
// registry.extend). To see the COMPOSED view schema (the re-homed @locale on
// view.currency) we compose the full `coreProviders` bundle. We additionally
// compose with ONLY the core-types provider to prove core itself now registers
// NO own attrs on any view subtype — the strict-completion invariant. The
// doc-domain common attrs (added universally by docProvider) are filtered out so
// this gate stays focused on the view/ui-owned attrs.
const registry = composeRegistry(coreProviders);
const coreOnlyRegistry = composeRegistry([coreTypesProvider]);

// The documentation common attrs are added to EVERY type by docProvider; they are
// not view/ui-owned, so the completeness gate ignores them.
const DOC_COMMON_ATTRS = new Set([
  "description",
  "title",
  "notes",
  "deprecated",
  "replacedBy",
  "seeAlso",
  "aliases",
  "summary",
]);

type ExpectedAttr = {
  valueType: string;
  required: boolean;
  default?: string;
};

// Only view.currency has an attr (@locale, re-homed to ui); every other subtype
// has none.
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

      const ownAttrs = def!.attributes.filter((a) => !DOC_COMMON_ATTRS.has(a.name));
      const actualNames = ownAttrs.map((a) => a.name).sort();
      expect(actualNames).toEqual(Object.keys(expected).sort());

      for (const attr of ownAttrs) {
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

    test(`view.${subType} — core registers NO own attrs (re-homed to ui)`, () => {
      // FR-033 S2: the view type attrs (@locale) are re-homed to the ui provider.
      // Core itself registers NO own (non-doc-common) attr on any view subtype.
      const def = coreOnlyRegistry.find(TYPE_VIEW, subType)!;
      const ownAttrs = def.attributes.filter((a) => !DOC_COMMON_ATTRS.has(a.name));
      expect(ownAttrs.map((a) => a.name)).toEqual([]);
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
