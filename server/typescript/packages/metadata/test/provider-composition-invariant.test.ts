// The OWN / PROJECTED invariant for provider composition.
//
// A provider is a CLUSTER OF CAPABILITIES. It may contribute new types, new
// subtypes, attributes intrinsic to its own types, and attributes projected onto
// types another cluster owns — in any combination, and projections may target
// only some subtypes (prompt puts @xmlText on every field, @enumAlias on
// field.enum alone, @normalize on object.value alone).
//
//   OWN       the type is invalid, unsatisfiable, or not meaningfully itself
//             without the attr -> it registers WITH the type, in the type's
//             provider, always.
//   PROJECTED a different cluster's concern applied to a type that is complete
//             without it -> it registers in the concern provider, and MUST be
//             optional.
//
// INVARIANT (what this file gates): removing a provider may remove types, and may
// remove OPTIONAL vocabulary from surviving types, but must never invalidate or
// silently weaken the validation of a type another provider registers.
//
// Why it is gated rather than documented. FR-033 re-homed template.*'s attrs into
// promptProvider, including the REQUIRED @payloadRef and @toolName. Composing
// without that "optional" provider left template.prompt registered with ZERO
// attributes, and ERR_MISSING_REQUIRED_ATTR simply stopped firing — invalid
// metadata began loading clean. Nothing failed; a rule went quiet. Every other
// concern provider already obeyed the invariant, so the rule was real and merely
// unwritten. This test writes it down in the only form that survives.
//
// Cross-port note: the shared registry manifest is provider-BLIND by design (it
// records types, attrs and child rules, never who registered them), so it cannot
// carry this gate. This is the reference-port statement of the invariant.

import { describe, expect, test } from "bun:test";
import { coreProviders, coreTypesProvider } from "../src/core-types.js";
import { composeRegistry } from "../src/provider.js";

/** type.subType -> attr name -> required */
function vocabulary(providers: readonly (typeof coreProviders)[number][]): Map<string, Map<string, boolean>> {
  const registry = composeRegistry(providers, { validate: true });
  const out = new Map<string, Map<string, boolean>>();
  for (const tid of registry.allTypes()) {
    const attrs = new Map<string, boolean>();
    for (const a of registry.attrsOf(tid.type, tid.subType)) {
      attrs.set(a.name, a.required === true);
    }
    out.set(`${tid.type}.${tid.subType}`, attrs);
  }
  return out;
}

const FULL = vocabulary([...coreProviders]);

describe("provider composition — the OWN/PROJECTED invariant", () => {
  const concerns = coreProviders.filter((p) => p.id !== coreTypesProvider.id);

  test("the bundle is more than core alone (guards against a vacuous sweep)", () => {
    expect(concerns.length).toBeGreaterThan(0);
    expect(FULL.size).toBeGreaterThan(0);
  });

  for (const dropped of concerns) {
    test(`dropping ${dropped.id} weakens no surviving type`, () => {
      const reduced = vocabulary(coreProviders.filter((p) => p.id !== dropped.id));
      const weakened: string[] = [];

      for (const [key, attrs] of FULL) {
        // A type that VANISHES was owned by the dropped provider — legitimate.
        // Only types that SURVIVE can be weakened by its absence.
        const survivor = reduced.get(key);
        if (survivor === undefined) continue;
        for (const [attr, required] of attrs) {
          if (required && !survivor.has(attr)) weakened.push(`${key} @${attr}`);
        }
      }

      expect(weakened).toEqual([]);
    });
  }

  // The positive half: dropping a concern SHOULD still reduce vocabulary, or the
  // sweep above would pass trivially on a bundle where nothing projects anything.
  test("concern providers do project optional vocabulary (the sweep is not vacuous)", () => {
    const projecting = concerns.filter((dropped) => {
      const reduced = vocabulary(coreProviders.filter((p) => p.id !== dropped.id));
      for (const [key, attrs] of FULL) {
        const survivor = reduced.get(key);
        if (survivor === undefined) continue;
        for (const attr of attrs.keys()) if (!survivor.has(attr)) return true;
      }
      return false;
    });
    expect(projecting.length).toBeGreaterThan(0);
  });
});
