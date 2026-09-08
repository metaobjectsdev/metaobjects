// The set the loader composes BY DEFAULT must register exactly the canonical vocabulary.
//
// `fixtures/registry-conformance/expected-registry.json` is the manifest all five ports
// byte-match, and `metadata`'s own conformance test pins it against `coreProviders`. But
// `coreProviders` is not what `loadMemory` composed — it composed
// `[...coreProviders, forgeTypesProvider]`, and that extra provider registers 20 `@forge*`
// common attrs and five top-level types (`decision`, `principle`, `convention`,
// `glossary`, `failure`) that appear in the canonical and in the other four ports'
// registries exactly nowhere.
//
// So every TypeScript consumer accepted a vocabulary no other port would load, and the
// cross-port gate could not see it: it was asserting about a provider LIST that the door
// adopters actually use did not match. One document, two verdicts — the defect the 0.25.0
// line was spent on — reachable through a second door nothing was watching, and 1.0 would
// have frozen it. Found by an adopter estate carrying nine such nodes.
//
// This gate closes the door rather than the instance: it asks the DEFAULT composition the
// same question the cross-port gate asks `coreProviders`, so any future provider quietly
// added to the default set fails here until it is either in the canonical (and therefore
// in all five ports) or moved back out to opt-in.
//
// It does NOT constrain what a consumer may register. ADR-0023's consumer-provider path is
// explicitly for that — `loadMemory(root, { providers: [mine] })` — and a project opting
// in knows it is choosing a surface the other ports do not have. The default is the
// cross-port surface; that is the whole distinction.

import { test, expect } from "bun:test";
import { join } from "node:path";
import { composeRegistry, emitRegistryManifest } from "@metaobjectsdev/metadata";
import { defaultLoadMemoryProviders } from "../src/memory.js";
import { forgeTypesProvider } from "../src/forge-types.js";

const CANONICAL = join(
  import.meta.dir,
  "../../../../../fixtures/registry-conformance/expected-registry.json",
);

const normalizeNewlines = (s: string): string => s.replace(/\r\n/g, "\n");

test("loadMemory's default provider set emits the canonical cross-port manifest", async () => {
  const registry = composeRegistry([...defaultLoadMemoryProviders]);
  const emitted = normalizeNewlines(emitRegistryManifest(registry));
  const committed = normalizeNewlines(await Bun.file(CANONICAL).text());

  if (emitted !== committed) {
    throw new Error(
      "loadMemory's DEFAULT composition registers vocabulary the canonical manifest does " +
        "not — so a document would load here and fail ERR_UNKNOWN_ATTR on the other four " +
        "ports. Either register it in all five ports and in expected-registry.json, or " +
        "take the provider out of the default set and let a consumer opt in.",
    );
  }
  expect(emitted).toBe(committed);
});

test("...and the gate is not vacuous — it convicts the provider that escaped it", () => {
  // Proves the comparison can CONVICT, using the exact provider this gate exists for. A
  // gate whose only evidence is a green run on a tree that is already correct proves it
  // ran, not that it can fail. Put `forgeTypesProvider` back where it was and the manifest
  // stops matching the canonical — which is what was true, unnoticed, until now.
  const asItWas = composeRegistry([...defaultLoadMemoryProviders, forgeTypesProvider]);
  const asItIs = composeRegistry([...defaultLoadMemoryProviders]);
  expect(emitRegistryManifest(asItWas)).not.toBe(emitRegistryManifest(asItIs));
});
