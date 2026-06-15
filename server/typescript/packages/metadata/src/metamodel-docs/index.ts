// FR-033 S3 — metamodel doc-gen public surface.
//
// Documents the METAMODEL ITSELF (the type/subtype/attr vocabulary of the strict
// registry) as tiered, LLM-readable markdown — distinct from `meta docs --model`
// (which documents a user's entities). The renderer is a pure, deterministic
// function over the composed registry + a provenance lens; file I/O lives in the
// CLI.

import type { TypeRegistry } from "../registry.js";
import { coreProviders } from "../core-types.js";
import { buildMetamodelProvenance, type MetamodelProvenance } from "./provenance.js";
import { renderMetamodelDocs } from "./render.js";

export { buildMetamodelProvenance, renderMetamodelDocs };
export type { MetamodelProvenance } from "./provenance.js";

/**
 * Build the provider-id → description map from the core provider bundle. The
 * descriptions live on the provider objects (not the embedded definitions), so
 * the provenance builder takes them as input; this assembles the default map
 * for the standard `coreProviders` composition.
 */
export function coreProviderDescriptions(): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of coreProviders) {
    if (p.description !== undefined) map.set(p.id, p.description);
  }
  return map;
}

/**
 * One-shot convenience: build the provenance lens (with the core provider
 * descriptions) and render the full metamodel doc tree from a composed registry.
 * The CLI uses this; tests can call the lower-level pieces directly.
 */
export function renderCoreMetamodelDocs(registry: TypeRegistry): Map<string, string> {
  const provenance: MetamodelProvenance = buildMetamodelProvenance(registry, {
    providerDescriptions: coreProviderDescriptions(),
  });
  return renderMetamodelDocs(registry, provenance);
}
