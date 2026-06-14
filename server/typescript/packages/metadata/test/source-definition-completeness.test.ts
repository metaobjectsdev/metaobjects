// source-definition-completeness — proves the FR-033 externalization of the
// CORE source registration (spec/metamodel/source.json, read via
// defineProviderFromData) is FAITHFUL and COMPLETE: a CORE-ONLY composed registry
// registers, for every source subtype, exactly the pre-FR-033 shape — NO own
// attrs (the bare source shells), childRules == [wildcard(attr)], and no dataType.
//
// CRITICAL isolation: this composes with ONLY coreTypesProvider. The
// @table/@kind/@role/@schema/@parameterRef attrs on source.rdb are contributed by
// a SEPARATE provider (dbProvider, persistence/db) via registry.extend — those
// are intentionally NOT part of this gate. Composing core-only is what isolates
// the core registration from the db-domain extend (the validator/identity/origin
// completeness tests do the same isolation; this follows that pattern).

import { describe, test, expect } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreTypesProvider } from "../src/core-types.js";
import { TYPE_SOURCE, TYPE_ATTR } from "../src/shared/base-types.js";
import { SOURCE_SUBTYPES } from "../src/persistence/source/source-constants.js";
import { CHILD_RULE_WILDCARD } from "../src/shared/structural.js";

// Compose with ONLY the core-types provider — so `def.attributes` reflects
// exactly what the CORE source registration produced, NOT the db-domain attrs
// that dbProvider adds via registry.extend(). This isolates the externalization
// gate.
const registry = composeRegistry([coreTypesProvider]);

describe("source CORE registration externalization — completeness", () => {
  test("registers all source subtypes (base, rdb)", () => {
    const registered = registry.allSubTypesOf(TYPE_SOURCE).sort();
    expect(registered).toEqual([...SOURCE_SUBTYPES].sort());
  });

  for (const subType of SOURCE_SUBTYPES) {
    test(`source.${subType} — CORE registration carries NO own attrs`, () => {
      const def = registry.find(TYPE_SOURCE, subType);
      expect(def).toBeDefined();
      expect(def!.attributes).toEqual([]);
    });

    test(`source.${subType} — childRules == [wildcard(attr)]`, () => {
      const def = registry.find(TYPE_SOURCE, subType)!;
      expect(def.childRules).toEqual([
        {
          childType: TYPE_ATTR,
          childSubType: CHILD_RULE_WILDCARD,
          childName: CHILD_RULE_WILDCARD,
        },
      ]);
    });

    test(`source.${subType} — carries no dataType`, () => {
      const def = registry.find(TYPE_SOURCE, subType)!;
      expect(def.dataType).toBeUndefined();
    });
  }
});
