// template-definition-completeness — proves the FR-033 externalization of the
// template provider (spec/metamodel/template.json, read via defineProviderFromData)
// is FAITHFUL and COMPLETE: a composed core registry registers, for every template
// subtype, exactly the expected attr name-set (+ valueType + isArray + required +
// default + allowedValues) AND the post-assigned childRules ([wildcard(attr)]) that
// the hand-coded template-schema.ts (TEMPLATE_ATTRS_MAP) + the old loop produced
// before the conversion. template is the most attr-heavy provider, so this is the
// critical fidelity gate — every attr is asserted.
//
// The expected table below is derived DIRECTLY from the pre-FR-033
// template/template-schema.ts (genericAttrs + promptOverlayAttrs +
// promptStyleAttr + outputKindAttrs + toolcallAttrs) and template-constants.ts
// (TEMPLATE_FORMATS / PROMPT_STYLES / PROMPT_STYLE_DEFAULT / TEMPLATE_KINDS /
// TEMPLATE_KIND_DEFAULT). It is the safety net the plan asks for.
//
// CRITICAL assertions:
//   - REQUIRED: prompt.@payloadRef, output.@payloadRef, toolcall.@toolName,
//     toolcall.@payloadRef.
//   - DEFAULTS + closed enums: @format (default "text", 7 formats),
//     @promptStyle (default "guide", 3 styles), @kind (default "document",
//     2 kinds).
//   - isArray: @requiredTags, @requiredSlots.
//   - base carries NO attrs; toolcall does NOT inherit genericAttrs.
//   - templates carry no dataType; childRules == [wildcard(attr)].

import { describe, test, expect } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreTypesProvider } from "../src/core-types.js";
import { TYPE_TEMPLATE, TYPE_ATTR } from "../src/shared/base-types.js";
import { TEMPLATE_SUBTYPES } from "../src/template/template-constants.js";
import { CHILD_RULE_WILDCARD } from "../src/shared/structural.js";

// Compose with ONLY the core-types provider — so `def.attributes` reflects
// exactly what the TEMPLATE provider registered, not the doc-domain attrs that
// other providers add via registry.extend(). This isolates the externalization
// gate.
const registry = composeRegistry([coreTypesProvider]);

type ExpectedAttr = {
  valueType: string;
  isArray: boolean;
  required: boolean;
  default?: string;
  allowedValues?: readonly string[];
};

const TEMPLATE_FORMATS = ["text", "html", "xml", "csv", "json", "markdown", "spreadsheet"];
const PROMPT_STYLES = ["guide", "inline", "exampleOnly"];
const TEMPLATE_KINDS = ["document", "email"];

// genericAttrs (shared by prompt + output), spelled out per subtype below.
const genericAttrs: Record<string, ExpectedAttr> = {
  payloadRef: { valueType: "string", isArray: false, required: true },
  textRef: { valueType: "string", isArray: false, required: false },
  format: {
    valueType: "string",
    isArray: false,
    required: false,
    default: "text",
    allowedValues: TEMPLATE_FORMATS,
  },
  maxChars: { valueType: "int", isArray: false, required: false },
  owner: { valueType: "string", isArray: false, required: false },
  since: { valueType: "string", isArray: false, required: false },
  requiredTags: { valueType: "string", isArray: true, required: false },
};

const EXPECTED: Record<string, Record<string, ExpectedAttr>> = {
  base: {},
  prompt: {
    ...genericAttrs,
    // promptOverlayAttrs
    maxTokens: { valueType: "int", isArray: false, required: false },
    requiredSlots: { valueType: "string", isArray: true, required: false },
    model: { valueType: "string", isArray: false, required: false },
    responseRef: { valueType: "string", isArray: false, required: false },
  },
  output: {
    ...genericAttrs,
    // promptStyleAttr
    promptStyle: {
      valueType: "string",
      isArray: false,
      required: false,
      default: "guide",
      allowedValues: PROMPT_STYLES,
    },
    // outputKindAttrs
    kind: {
      valueType: "string",
      isArray: false,
      required: false,
      default: "document",
      allowedValues: TEMPLATE_KINDS,
    },
    subjectRef: { valueType: "string", isArray: false, required: false },
    htmlBodyRef: { valueType: "string", isArray: false, required: false },
    textBodyRef: { valueType: "string", isArray: false, required: false },
  },
  toolcall: {
    // toolcallAttrs — does NOT inherit genericAttrs
    toolName: { valueType: "string", isArray: false, required: true },
    payloadRef: { valueType: "string", isArray: false, required: true },
    owner: { valueType: "string", isArray: false, required: false },
    since: { valueType: "string", isArray: false, required: false },
  },
};

describe("template provider externalization — completeness", () => {
  test("registers all 4 template subtypes", () => {
    const registered = registry.allSubTypesOf(TYPE_TEMPLATE).sort();
    expect(registered).toEqual([...TEMPLATE_SUBTYPES].sort());
  });

  for (const subType of TEMPLATE_SUBTYPES) {
    test(`template.${subType} — attr name-set, valueType, isArray, required, default, allowedValues match the pre-FR-033 schema`, () => {
      const def = registry.find(TYPE_TEMPLATE, subType);
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
        if (exp!.default !== undefined) {
          expect(attr.default).toBe(exp!.default);
        } else {
          expect(attr.default).toBeUndefined();
        }
        if (exp!.allowedValues) {
          expect(attr.allowedValues).toEqual(exp!.allowedValues);
        } else {
          expect(attr.allowedValues).toBeUndefined();
        }
      }
    });

    test(`template.${subType} — childRules == [wildcard(attr)]`, () => {
      const def = registry.find(TYPE_TEMPLATE, subType)!;
      expect(def.childRules).toEqual([
        {
          childType: TYPE_ATTR,
          childSubType: CHILD_RULE_WILDCARD,
          childName: CHILD_RULE_WILDCARD,
        },
      ]);
    });
  }

  test("templates carry no dataType", () => {
    for (const subType of TEMPLATE_SUBTYPES) {
      const def = registry.find(TYPE_TEMPLATE, subType)!;
      expect(def.dataType).toBeUndefined();
    }
  });
});
