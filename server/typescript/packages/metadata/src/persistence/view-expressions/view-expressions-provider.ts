// viewExpressionsProvider — the view-expressions pack: the vocabulary a projection
// needs to replace a hand-written `@sql` view. New in 1.3.0 (rc.21), and today acted
// on by the TypeScript and C# ports (`implementedIn`).
//
// It carries `origin.function` (a value computed by a database function the project
// owns) and the projection attributes `@union` / `@unionAll` (the view is a UNION of
// other projections) and `@grain` / `@grainOrdinal` (one row per element of an
// array-of-value-object field). It is its OWN provider so a project can leave it out
// and the vocabulary can move or be versioned on its own; it is in the default bundle
// (`coreProviders`), so every existing model loads unchanged. GOVERNANCE.md
// ("Extension packs and the core metamodel"): new vocabulary lives in a pack until a
// second consumer needs it in core.
//
// What this pack does NOT carry: the `cast` node and the SQL function set are nodes of
// the `attr.expression` value grammar (parsed by the expression reader, not
// registered), and the text `@dbColumnType` spellings are validated in code; neither
// is registry vocabulary, so neither can be composed out by a provider.

import type { MetaDataTypeProvider } from "../../provider.js";
import type { TypeRegistry, TypeId } from "../../registry.js";
import { applyProviderDefinition, type FactoryMap } from "../../provider-data.js";
import { MetaOrigin } from "../origin/meta-origin.js";
import { TYPE_ORIGIN } from "../../shared/base-types.js";
import { ORIGIN_SUBTYPE_FUNCTION } from "../origin/origin-constants.js";
import { VIEW_EXPRESSIONS_DEFINITION } from "./view-expressions-definition.embedded.js";

/** The view-expressions pack's provider id (a logical id, shared by every port). */
export const VIEW_EXPRESSIONS_PROVIDER_ID = "metaobjects-view-expressions";

export const viewExpressionsProvider: MetaDataTypeProvider = {
  id: VIEW_EXPRESSIONS_PROVIDER_ID,
  dependencies: ["metaobjects-core-types"],
  description:
    "View expressions (rc.21): origin.function plus the projection @union / @unionAll / @grain / @grainOrdinal attributes.",
  registerTypes(registry: TypeRegistry): void {
    const factories: FactoryMap = {
      [`${TYPE_ORIGIN}.${ORIGIN_SUBTYPE_FUNCTION}`]: (typeId: TypeId, name: string) =>
        new MetaOrigin(typeId, name),
    };
    applyProviderDefinition(registry, VIEW_EXPRESSIONS_DEFINITION, factories);
  },
};
