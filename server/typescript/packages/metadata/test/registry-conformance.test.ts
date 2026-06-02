// SP-G Registry Conformance — TS reference assertion.
//
// Asserts that the manifest emitted from the assembled core TypeRegistry is
// byte-identical to the committed single-source canonical
// fixtures/registry-conformance/expected-registry.json. TS is the reference
// port: this pins both the canonical AND the exact serialization the other four
// ports (C#, Java, Kotlin, Python) must byte-match.
//
// A drift here means either the TS registry changed (the canonical needs
// regenerating + the other ports reconciling) or the emitter changed. See
// fixtures/registry-conformance/README.md for the in/out boundary + the
// fix-at-source-on-divergence rule.

import { test, expect } from "bun:test";
import { join } from "node:path";
import { composeRegistry } from "../src/provider.js";
import { coreProviders } from "../src/core-types.js";
import { buildRegistryManifest, emitRegistryManifest } from "../src/registry-manifest.js";

// The canonical lives at the REPO ROOT — five `../` levels up from test/
// (test → metadata → packages → typescript → server → repo-root).
const CANONICAL = join(
  import.meta.dir,
  "../../../../../fixtures/registry-conformance/expected-registry.json",
);

/** Normalize line endings so a CRLF checkout cannot fail a content-equal manifest. */
function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

test("TS registry manifest matches the committed canonical", async () => {
  const registry = composeRegistry(coreProviders);
  const emitted = normalizeNewlines(emitRegistryManifest(registry));
  const committed = normalizeNewlines(await Bun.file(CANONICAL).text());

  if (emitted !== committed) {
    throw new Error(
      "TS registry drifted from the committed manifest — regenerate " +
        "(and reconcile the other ports) or fix the registration.",
    );
  }
  expect(emitted).toBe(committed);
});

// SP-G Phase1 Units2-3 — the emitter exclusions (structural keywords, the
// metadata.base anchor, the generic view.* controls) are documented, principled,
// and uniform across all four ports. These assert the contract directly.
test("manifest excludes structural-keyword/commonAttr per-type attrs (isArray/isAbstract/description)", () => {
  const manifest = buildRegistryManifest(composeRegistry(coreProviders));
  for (const t of manifest.types) {
    for (const a of t.attrs) {
      expect(["isArray", "isAbstract", "description"]).not.toContain(a.name);
    }
  }
  // `description` is still carried in the commonAttrs block.
  expect(manifest.commonAttrs.map((a) => a.name)).toContain("description");
});

test("manifest excludes the metadata.base inheritance anchor (keeps metadata.root)", () => {
  const manifest = buildRegistryManifest(composeRegistry(coreProviders));
  const metadataSubTypes = manifest.types
    .filter((t) => t.type === "metadata")
    .map((t) => t.subType);
  expect(metadataSubTypes).not.toContain("base");
  expect(metadataSubTypes).toContain("root");
});

test("manifest cuts the 11 generic view.* controls, keeps view.base + view.currency", () => {
  const manifest = buildRegistryManifest(composeRegistry(coreProviders));
  const viewSubTypes = manifest.types
    .filter((t) => t.type === "view")
    .map((t) => t.subType)
    .sort();
  expect(viewSubTypes).toEqual(["base", "currency"]);
});
