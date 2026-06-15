// attr-definition-completeness — proves the FR-033 externalization of the attr
// provider (spec/metamodel/attr.json, read via defineProviderFromData) is
// FAITHFUL and COMPLETE: a composed core registry registers, for every attr
// subtype, NO per-type attrs, NO childRules, and the same dataType the hand-coded
// loop produced before the conversion (probed off the subtype's MetaAttr class).
//
// attrs are leaf value-type vocabulary — they carry no children and no attrs of
// their own — so the safety net is: empty attributes, empty childRules, and a
// dataType byte-matching attrClassFor(subType)'s probe.

import { describe, test, expect } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreTypesProvider } from "../src/core-types.js";
import { TYPE_ATTR } from "../src/shared/base-types.js";
import { ATTR_SUBTYPES } from "../src/core/attr/attr-constants.js";
import { attrClassFor } from "../src/attr-class-map.js";
import { TypeId } from "../src/registry.js";

// Compose with ONLY the core-types provider — so `def.attributes` reflects
// exactly what the ATTR provider registered, not the doc-domain commonAttrs that
// other providers add via registry.extend(). This isolates the externalization gate.
const registry = composeRegistry([coreTypesProvider]);

/** The pre-FR-033 dataType per attr subtype, probed off the subtype's class. */
function probedDataType(subType: string): string {
  return new (attrClassFor(subType))(new TypeId(TYPE_ATTR, subType), "").dataType;
}

describe("attr provider externalization — completeness", () => {
  test("registers all 9 attr subtypes", () => {
    const registered = registry.allSubTypesOf(TYPE_ATTR).sort();
    expect(registered).toEqual([...ATTR_SUBTYPES].sort());
  });

  for (const subType of ATTR_SUBTYPES) {
    test(`attr.${subType} — no attrs, no childRules, dataType matches the pre-FR-033 probe`, () => {
      const def = registry.find(TYPE_ATTR, subType);
      expect(def).toBeDefined();

      // attrs carry no per-type attributes and no childRules.
      expect(def!.attributes).toEqual([]);
      expect(def!.childRules).toEqual([]);

      // dataType matches the subtype's MetaAttr class probe.
      expect(def!.dataType as string | undefined).toBe(probedDataType(subType));
    });
  }
});
