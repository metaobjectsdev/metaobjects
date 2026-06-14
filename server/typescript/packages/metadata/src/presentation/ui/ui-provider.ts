// uiProvider — the presentation + query-surface MetaDataTypeProvider. Extends
// every field subtype with the UI/query-surface markers @filterable / @sortable /
// @sortableDefaultOrder by extending the core-registered field types. These are
// presentation/query concerns, NOT core field properties, so they live here —
// mirroring the dbProvider (db-provider.ts) and promptProvider patterns.
//
// FR-033 S1-field-A re-homes these attrs out of the core field definition
// (spec/metamodel/field.json) into this concern provider. Pure ownership move:
// the same attrs land on the same field subtypes, so the composed registry
// manifest stays byte-identical — only the owning provider changes.

import type { MetaDataTypeProvider } from "../../provider.js";
import type { TypeRegistry } from "../../registry.js";
import { TYPE_FIELD } from "../../shared/base-types.js";
import { FIELD_SUBTYPES } from "../../core/field/field-constants.js";
import { uiFieldAttrs } from "./ui-schema.js";

export const uiProvider: MetaDataTypeProvider = {
  id: "metaobjects-ui",
  dependencies: ["metaobjects-core-types"],
  description:
    "UI/query-surface domain — @filterable / @sortable / @sortableDefaultOrder field markers driving generated CRUD filter + sort allowlists (Project D).",
  registerTypes(registry: TypeRegistry): void {
    for (const subType of FIELD_SUBTYPES) {
      registry.extend(TYPE_FIELD, subType, { attributes: [...uiFieldAttrs] });
    }
  },
};
