// uiProvider — the presentation + query-surface MetaDataTypeProvider. Extends
// every field subtype with the UI/query-surface markers @filterable / @sortable /
// @sortableDefaultOrder by extending the core-registered field types. These are
// presentation/query concerns, NOT core field properties, so they live here —
// mirroring the dbProvider (db-provider.ts) and promptProvider patterns.
//
// FR-033 S1.5-B: the attrs + their descriptions are now DATA — read from
// spec/metamodel/ui.json (embedded as UI_DEFINITION) via the unified
// applyProviderDefinition apply path's `extends` handling. The provider declares
// no new types, so the factory map is empty.

import type { MetaDataTypeProvider } from "../../provider.js";
import type { TypeRegistry } from "../../registry.js";
import { applyProviderDefinition } from "../../provider-data.js";
import { UI_DEFINITION } from "./ui-definition.embedded.js";

export const uiProvider: MetaDataTypeProvider = {
  id: "metaobjects-ui",
  dependencies: ["metaobjects-core-types"],
  description:
    "UI/query-surface domain — @filterable / @sortable / @sortableDefaultOrder field markers driving generated CRUD filter + sort allowlists (Project D).",
  registerTypes(registry: TypeRegistry): void {
    applyProviderDefinition(registry, UI_DEFINITION, {});
  },
};
