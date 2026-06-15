// ui-definition-completeness — proves the FR-033 S1.5-B data-driven ui provider
// (spec/metamodel/ui.json, read via applyProviderDefinition's `extends` path)
// lands EXACTLY the pre-S1.5 UI/query-surface attrs on the right targets:
//   - @filterable / @sortable / @sortableDefaultOrder on EVERY field subtype.
//
// Composes core + ui so the ui extends apply on top of the core-registered types
// (the byte-identical-canonical proof is the registry-conformance gate; this is
// the focused per-target placement assertion).

import { describe, test, expect } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreTypesProvider } from "../src/core-types.js";
import { uiProvider } from "../src/presentation/ui/ui-provider.js";
import { TYPE_FIELD } from "../src/shared/base-types.js";
import { FIELD_SUBTYPES } from "../src/core/field/field-constants.js";

const registry = composeRegistry([coreTypesProvider, uiProvider]);

function attrNames(type: string, subType: string): string[] {
  return registry.find(type, subType)!.attributes.map((a) => a.name);
}

describe("ui provider (data-driven) — attr placement", () => {
  for (const subType of FIELD_SUBTYPES) {
    test(`field.${subType} — @filterable / @sortable / @sortableDefaultOrder present`, () => {
      const names = attrNames(TYPE_FIELD, subType);
      expect(names).toContain("filterable");
      expect(names).toContain("sortable");
      expect(names).toContain("sortableDefaultOrder");
    });
  }

  test("@sortableDefaultOrder carries the asc/desc allowedValues", () => {
    const attr = registry
      .find(TYPE_FIELD, "string")!
      .attributes.find((a) => a.name === "sortableDefaultOrder")!;
    expect(attr.allowedValues).toEqual(["asc", "desc"]);
  });
});
