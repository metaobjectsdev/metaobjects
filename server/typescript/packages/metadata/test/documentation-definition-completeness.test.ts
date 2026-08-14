// documentation-definition-completeness — proves the FR-033 externalization of
// the documentation provider (spec/metamodel/documentation.json — the universal
// `*.*` entry, registered via applyProviderDefinition → registerCommonAttrs) is
// FAITHFUL and COMPLETE: a registry composed from the full coreProviders set
// exposes, via registry.getCommonAttrs(), EXACTLY the 8 universal doc common
// attrs with matching name / valueType / isArray / required / description.
//
// The EXPECTED table below started as a verbatim copy of the pre-FR-033
// hand-coded commonDocAttrs in core/documentation/doc-schema.ts (now deleted) —
// the safety net proving the data-driven registration reproduced the old schema.
// That migration is long done, so the table is no longer a historical snapshot:
// it pins the CURRENTLY REGISTERED text, and an unintended edit to the embedded
// definition fails here. Drift between the embedded copy and the root
// spec/metamodel/documentation.json is a different question, covered by
// documentation-definition-embed.test.ts.
//
// Updating a description here is therefore expected and legitimate — but it is
// one of SEVEN places the same string lives (root spec, three per-port spec
// copies, the TS embedded definition, this pin, and the byte-gated
// fixtures/registry-conformance/expected-registry.json), so change them together
// and regenerate the manifest.

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
      "What this element IS and COVERS, written for someone using it. Markdown allowed, multi-line via YAML '|' block scalar. Flows into doc-gen surfaces (JSDoc / XML-doc / Postgres COMMENT / Mermaid prose). State scope and boundary — what it covers, what it deliberately does NOT, and which sibling owns the rest — all of which is derivable from the model itself. Anything you had to read the implementation to learn belongs in @notes, not here.",
  },
  summary: {
    valueType: "string",
    required: false,
    description:
      "Short single-line SENTENCE (OpenAPI `summary` pattern) — used in index tables, sidebar previews, and AI prompts where the full @description is too long. Distinct from @title, which is a noun label rather than a sentence. When @summary is unset, doc surfaces typically fall back to the first sentence of @description.",
  },
  title: {
    valueType: "string",
    required: false,
    description:
      "Short single-line human label — a NOUN PHRASE naming the element (e.g. 'Email' for a `field.string email`), never a sentence. What a tab, an index row or a sidebar shows when the name is an identifier rather than a label. See @summary for the one-line sentence form.",
  },
  notes: {
    valueType: "string",
    required: false,
    description:
      "Internal-only rationale, never emitted to user-facing docs — the slot for what you had to look OUTSIDE the model to learn: evidence, measurements, citations, the control that proved an absence was real, and what breaks if this changes. It is NOT a longer @description, and restating the description here is the failure mode this slot invites. Mechanical test: a sentence belongs in @notes exactly when it would have to change because the IMPLEMENTATION changed while the model did not.",
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
