// rulesProvider — the business-rules pack (ADR-0066): the declared API surface
// (api / operation / binding) and lifecycle moves (transition, a child of
// field.enum). Experimental, new in 1.3.0.
//
// It is its OWN provider rather than part of metaobjects-core-types so a project can
// leave it out, and so the vocabulary can move or be versioned on its own. It is in
// the default bundle (`coreProviders`), so every existing model loads unchanged.
// GOVERNANCE.md ("Extension packs and the core metamodel"): new vocabulary lives in a
// pack until a second consumer needs it in core.
//
// The pack owns its types (api.json, transition.json) AND the child rules that admit
// them on types core owns (`metadata.root` holds an `api`; `field.enum` holds a
// `transition`) — both ride in each file's `extends`. Compose the pack out and the
// types are unknown (ERR_UNKNOWN_TYPE); nothing of it is left behind in core. The
// cross-node rules live in loader/rules-validation.ts and only fire on rules nodes.

import type { MetaDataTypeProvider } from "../../provider.js";
import type { TypeRegistry, TypeId } from "../../registry.js";
import { applyProviderDefinition, type FactoryMap } from "../../provider-data.js";
import { TYPE_API, TYPE_OPERATION, TYPE_BINDING } from "../../shared/base-types.js";
import { MetaApi, MetaBinding, MetaOperation } from "../api/meta-api.js";
import { API_DEFINITION } from "../api/api-definition.embedded.js";
import { MetaTransition } from "../transition/meta-transition.js";
import { TRANSITION_DEFINITION } from "../transition/transition-definition.embedded.js";

/** The business-rules pack's provider id (a logical id, shared by every port). */
export const RULES_PROVIDER_ID = "metaobjects-rules";

export const rulesProvider: MetaDataTypeProvider = {
  id: RULES_PROVIDER_ID,
  dependencies: ["metaobjects-core-types"],
  description:
    "Business rules (ADR-0066, experimental): the declared API surface (api / operation / binding) and lifecycle moves (transition on a field.enum).",
  registerTypes(registry: TypeRegistry): void {
    // One class per type; the subtype carries no behaviour of its own.
    const factories: FactoryMap = {};
    for (const def of [...(API_DEFINITION.types ?? []), ...(TRANSITION_DEFINITION.types ?? [])]) {
      const key = `${def.type}.${def.subType}`;
      if (def.type === TYPE_API) factories[key] = (typeId: TypeId, name: string) => new MetaApi(typeId, name);
      else if (def.type === TYPE_OPERATION) factories[key] = (typeId: TypeId, name: string) => new MetaOperation(typeId, name);
      else if (def.type === TYPE_BINDING) factories[key] = (typeId: TypeId, name: string) => new MetaBinding(typeId, name);
      else factories[key] = (typeId: TypeId, name: string) => new MetaTransition(typeId, name);
    }
    applyProviderDefinition(registry, API_DEFINITION, factories);
    applyProviderDefinition(registry, TRANSITION_DEFINITION, factories);
  },
};
