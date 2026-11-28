// FR-033 S3 — metamodel doc-gen public surface.
//
// Documents the METAMODEL ITSELF (the type/subtype/attr vocabulary of the strict
// registry) as tiered, LLM-readable markdown, distinct from the `docs` generator
// (which documents a user's entities). This module builds each page's DATA, a pure,
// deterministic function over the registry vocabulary manifest and the embedded
// provider definitions; the shared Mustache templates (`templates/metamodel/`) lay
// the pages out, and the `metamodel-docs` generator in codegen-ts renders them.

import type { TypeRegistry } from "../registry.js";
import { coreProviders } from "../core-types.js";
import { composeRegistry } from "../provider.js";
import { buildRegistryManifest } from "../registry-manifest.js";
import { ALL_PROVIDER_DEFINITIONS } from "./provider-definitions.js";
import { buildMetamodelDocsPages, type MetamodelDocsPage } from "./pages.js";

export {
  buildMetamodelDocsPages,
  METAMODEL_INDEX_PAGE_REF,
  METAMODEL_PROVIDERS_PAGE_REF,
  METAMODEL_TYPE_PAGE_REF,
} from "./pages.js";
export type { MetamodelDocsPage } from "./pages.js";
export { ALL_PROVIDER_DEFINITIONS } from "./provider-definitions.js";

/**
 * The provider-id → description map of the core provider bundle. The descriptions live
 * on the provider objects, not in the embedded definitions. The other ports read the same
 * map from the template set's `metamodel/provider-descriptions.json`, which a test holds
 * equal to this.
 */
export function coreProviderDescriptions(): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of coreProviders) {
    if (p.description !== undefined) map.set(p.id, p.description);
  }
  return map;
}

/**
 * The metamodel reference pages of a composed registry (by default the core providers'),
 * with the core provider definitions and descriptions: what the generator renders.
 */
export function coreMetamodelDocsPages(
  registry: TypeRegistry = composeRegistry(coreProviders),
): MetamodelDocsPage[] {
  return buildMetamodelDocsPages(
    buildRegistryManifest(registry),
    ALL_PROVIDER_DEFINITIONS,
    coreProviderDescriptions(),
  );
}
