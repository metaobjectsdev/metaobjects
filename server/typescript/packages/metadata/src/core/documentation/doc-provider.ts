import type { MetaDataTypeProvider } from "../../provider.js";
import type { TypeRegistry } from "../../registry.js";
import { applyProviderDefinition } from "../../provider-data.js";
import { DOCUMENTATION_DEFINITION } from "./documentation-definition.embedded.js";

export const docProvider: MetaDataTypeProvider = {
  id: "metaobjects-documentation",
  dependencies: ["metaobjects-core-types"],
  description: "Universal documentation common attrs (description / title / notes / deprecated / replacedBy / seeAlso / aliases) accepted on every metatype.",
  registerTypes(registry: TypeRegistry): void {
    // FR-033 — the unified apply path: documentation's universal `*.*` entry
    // carries the doc attrs, which `applyProviderDefinition` routes to
    // `registry.registerCommonAttrs(...)`. No documentation-specific helper.
    applyProviderDefinition(registry, DOCUMENTATION_DEFINITION, {});
  },
};
