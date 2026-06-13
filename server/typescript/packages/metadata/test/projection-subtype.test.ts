// FR-024 Task B1 — object.projection subtype registration.
//
// Registers the third object subtype: `projection` — a derived, read-only
// representation of entities (ADR-0028). This test asserts ONLY registration +
// child-licensing; validation rules and resolution land in Tasks B2–B6. The
// subtype is carved OUT of the registry manifest (FR024_PENDING) until the
// atomic all-ports flip in FR-024 Phase E — see registry-conformance.test.ts.

import { describe, expect, test } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreProviders } from "../src/core-types.js";
import {
  TYPE_OBJECT,
  TYPE_RELATIONSHIP,
  TYPE_FIELD,
  TYPE_IDENTITY,
  TYPE_SOURCE,
  TYPE_TEMPLATE,
} from "../src/shared/base-types.js";
import {
  OBJECT_SUBTYPE_PROJECTION,
  OBJECT_SUBTYPES,
} from "../src/core/object/object-constants.js";
import { childRuleMatches } from "../src/registry.js";

describe("FR-024 object.projection registration", () => {
  const registry = composeRegistry(coreProviders);

  test("projection subtype is registered", () => {
    expect(OBJECT_SUBTYPES).toContain("projection");
    expect(registry.find(TYPE_OBJECT, OBJECT_SUBTYPE_PROJECTION)).toBeDefined();
  });

  test("projection licenses field/identity/source children but NOT relationship/template", () => {
    const definition = registry.find(TYPE_OBJECT, OBJECT_SUBTYPE_PROJECTION);
    expect(definition).toBeDefined();
    const rules = definition!.childRules;
    const matches = (type: string) =>
      rules.some((r) => childRuleMatches(r, { type, subType: "x", name: "x" }));
    expect(matches(TYPE_FIELD)).toBe(true);
    expect(matches(TYPE_IDENTITY)).toBe(true);
    expect(matches(TYPE_SOURCE)).toBe(true);
    expect(matches(TYPE_RELATIONSHIP)).toBe(false);
    expect(matches(TYPE_TEMPLATE)).toBe(false);
  });
});
