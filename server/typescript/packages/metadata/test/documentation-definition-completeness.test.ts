// documentation-definition-completeness — proves the FR-033 externalization of
// the documentation provider (spec/metamodel/documentation.json — the universal
// `*.*` entry, registered via applyProviderDefinition → registerCommonAttrs) is
// FAITHFUL and COMPLETE: a registry composed from the full coreProviders set
// exposes, via registry.getCommonAttrs(), EXACTLY the 8 universal doc common
// attrs with matching name / valueType / isArray / required / description.
//
// The EXPECTED table below is hardcoded verbatim from the pre-FR-033 hand-coded
// commonDocAttrs in core/documentation/doc-schema.ts (now deleted). It is the
// safety net that proves the data-driven registration reproduces the old schema.

import { describe, test, expect } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreProviders } from "../src/core-types.js";

type ExpectedAttr = {
  valueType: string;
  isArray?: boolean;
  required: boolean;
  description: string;
};

// Verbatim from the pre-FR-033 doc-schema.ts commonDocAttrs (declaration order).
const EXPECTED: Record<string, ExpectedAttr> = {
  description: {
    valueType: "string",
    required: false,
    description:
      "Free-form user-facing prose. Markdown allowed, multi-line via YAML '|' block scalar. Flows into doc-gen surfaces (JSDoc / XML-doc / Postgres COMMENT / Mermaid prose).",
  },
  summary: {
    valueType: "string",
    required: false,
    description:
      "Short single-line tagline (OpenAPI `summary` pattern) — used in index tables, sidebar previews, and AI prompts where the full @description is too long. Optional supplement to @description; when @summary is unset, doc surfaces typically fall back to the first sentence of @description.",
  },
  title: {
    valueType: "string",
    required: false,
    description:
      "Short single-line human label (e.g. 'Email' for a `field.string email`). Optional supplement to description.",
  },
  notes: {
    valueType: "string",
    required: false,
    description: "Internal-only rationale. Stays in metadata; never emitted to user-facing docs.",
  },
  deprecated: {
    valueType: "string",
    required: false,
    description:
      "Text reason for deprecation. Presence ⇒ deprecated. Codegen emits @deprecated / [Obsolete] with this reason.",
  },
  replacedBy: {
    valueType: "string",
    required: false,
    description:
      "FQN reference to the replacement element. Only meaningful with `deprecated`. Codegen appends 'Replaced by <ref>' to deprecation messages.",
  },
  seeAlso: {
    valueType: "string",
    isArray: true,
    required: false,
    description: "External documentation URLs. Codegen emits @see / <seealso href=...>.",
  },
  aliases: {
    valueType: "string",
    isArray: true,
    required: false,
    description: "Alternate names for this element. Aids AI authoring disambiguation, search, migration.",
  },
};

const registry = composeRegistry(coreProviders);
const commonAttrs = registry.getCommonAttrs();

describe("documentation provider externalization — completeness", () => {
  test("registers exactly the 8 expected common attrs", () => {
    const names = commonAttrs.map((a) => a.name).sort();
    expect(names).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [name, exp] of Object.entries(EXPECTED)) {
    test(`@${name} — name / valueType / isArray / required / description match the pre-FR-033 schema`, () => {
      const attr = commonAttrs.find((a) => a.name === name);
      expect(attr).toBeDefined();
      expect(attr!.valueType as string).toBe(exp.valueType);
      expect(attr!.required).toBe(exp.required);
      expect(attr!.description).toBe(exp.description);
      if (exp.isArray) {
        expect(attr!.isArray).toBe(true);
      } else {
        expect(attr!.isArray).toBeUndefined();
      }
    });
  }
});
