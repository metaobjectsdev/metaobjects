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
import { coreProviders, coreTypesProvider } from "../src/core-types.js";
import { TYPE_TEMPLATE } from "../src/shared/base-types.js";
import { TEMPLATE_SUBTYPES } from "../src/template/template-constants.js";
import { validateAttrSchema } from "../src/attr-schema-validate.js";
import { parseJson } from "../src/parser-json.js";

// FR-033 S2: the template.* type attrs (@payloadRef/@textRef/@format/@kind/…) were
// re-homed OUT of core into the PROMPT concern provider (spec/metamodel/prompt.json
// → promptProvider, applied via registry.extend). To see the COMPOSED template
// schema (the re-homed attrs on prompt/output/toolcall) we compose the full
// `coreProviders` bundle. We additionally compose with ONLY the core-types
// provider to prove core itself now registers NO own attrs on any template subtype
// — the strict-completion invariant. The doc-domain common attrs (added
// universally by docProvider) are filtered out so this gate stays focused on the
// template/prompt-owned attrs.
const registry = composeRegistry(coreProviders);
const coreOnlyRegistry = composeRegistry([coreTypesProvider]);

// The documentation common attrs are added to EVERY type by docProvider; they are
// not template/prompt-owned, so the completeness gate ignores them.
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

// Strict-load validation (ADR-0023): the any-attr/structural strict checks fire
// only under strict=true. Compose the full coreProviders bundle so the re-homed
// template attrs (prompt provider) are registered, then run validateAttrSchema
// strict over the parsed document — mirroring the strict-load gate.
function strictErrors(children: unknown[]) {
  const registry = composeRegistry(coreProviders);
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const { root } = parseJson(json, { registry });
  return validateAttrSchema(root, registry, true).errors.map((e) => e.code);
}

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
    // #237 — vendor-agnostic per-call token budget (peer of @maxTokens on prompt).
    maxTokens: { valueType: "int", isArray: false, required: false },
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

      const ownAttrs = def!.attributes.filter((a) => !DOC_COMMON_ATTRS.has(a.name));
      const actualNames = ownAttrs.map((a) => a.name).sort();
      expect(actualNames).toEqual(Object.keys(expected).sort());

      for (const attr of ownAttrs) {
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

    test(`template.${subType} — core registers its OWN attrs, without promptProvider`, () => {
      // SUPERSEDES FR-033 S2, which re-homed these attrs to the prompt provider.
      //
      // They are OWN attrs, not a projected concern: `@payloadRef` is REQUIRED, the
      // type's own registered description names the LLM overlay, and core's own
      // validation passes enforce presence rules over `@textRef`/`@kind`. An attr a
      // type cannot be valid without belongs to that type's provider.
      //
      // While they lived in promptProvider, composing without it left the type
      // registered with ZERO attributes and silently deleted the required-attr rule
      // — a surviving type losing a validation rule when an "optional" concern is
      // dropped. Measured: `ERR_MISSING_REQUIRED_ATTR` simply stopped firing.
      const def = coreOnlyRegistry.find(TYPE_TEMPLATE, subType)!;
      const ownAttrs = def.attributes.filter((a) => !DOC_COMMON_ATTRS.has(a.name));
      // `base` is the abstract root: attr-free by design, matching Java and the
      // cross-port canonical. The CONCRETE subtypes must carry their own attrs in
      // core, required-ness intact, with no concern provider composed.
      if (subType === "base") {
        expect(ownAttrs.map((a) => a.name)).toEqual([]);
        return;
      }
      expect(ownAttrs.length).toBeGreaterThan(0);
      expect(ownAttrs.some((a) => a.required === true)).toBe(true);
    });

    test(`template.${subType} — childRules == [] (no any-attr wildcard)`, () => {
      // FR-033 S2: with the type attrs re-homed to the prompt provider, template
      // is now an ATTR-ONLY type. The "any attr" wildcard child rule is DROPPED
      // (strict completion — like view/layout/source) — childRules are EMPTY.
      const def = registry.find(TYPE_TEMPLATE, subType)!;
      expect(def.childRules).toEqual([]);
    });
  }

  test("templates carry no dataType", () => {
    for (const subType of TEMPLATE_SUBTYPES) {
      const def = registry.find(TYPE_TEMPLATE, subType)!;
      expect(def.dataType).toBeUndefined();
    }
  });

  // FR-033 S2 strict-bite — with the any-attr wildcard gone, template is
  // fail-closed: a non-declared attr → ERR_UNKNOWN_ATTR; a structural child under
  // a template → ERR_CHILD_NOT_ALLOWED.
  const authorBrief = {
    "object.value": {
      name: "AuthorBrief",
      children: [{ "field.string": { name: "displayName" } }],
    },
  };

  test("an undeclared attr on template.prompt → ERR_UNKNOWN_ATTR (strict)", () => {
    const errs = strictErrors([
      authorBrief,
      {
        "template.prompt": {
          name: "strategy",
          "@payloadRef": "AuthorBrief",
          "@textRef": "prompt/strategy",
          "@notADeclaredAttr": "boom",
        },
      },
    ]);
    expect(errs).toContain("ERR_UNKNOWN_ATTR");
  });

  test("a field structural child under template.output → ERR_CHILD_NOT_ALLOWED (strict)", () => {
    const errs = strictErrors([
      authorBrief,
      {
        "template.output": {
          name: "doc",
          "@payloadRef": "AuthorBrief",
          "@textRef": "doc/body",
          children: [{ "field.string": { name: "stray" } }],
        },
      },
    ]);
    expect(errs).toContain("ERR_CHILD_NOT_ALLOWED");
  });
});
