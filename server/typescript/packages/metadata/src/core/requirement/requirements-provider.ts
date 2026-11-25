// requirementsProvider — the requirements pack: `requirement.functional` and
// `requirement.architectural`, declared beside the entities they describe.
//
// It is its OWN provider rather than part of metaobjects-core-types so a project can
// leave it out and the vocabulary can move or be versioned on its own. It is in the
// default bundle (`coreProviders`), so every existing model loads unchanged.
// GOVERNANCE.md ("Extension packs and the core metamodel"): vocabulary lives in a
// pack until a second consumer needs it in core.
//
// The pack owns its types (requirement.json) AND the child rule that admits them on
// `metadata.root` (the file's `extends`). Compose the pack out and a `requirement.*`
// node is ERR_UNKNOWN_TYPE; `meta verify`'s requirement gate then has no ledger to
// read and reports nothing.
//
// @implementedBy is deliberately NOT declared as a loader `references` descriptor. That
// pass always ERRORS on an unresolved target, and a requirement with status `planned`
// names nodes that do not exist YET (and a `retired` one names nodes that are GONE), so
// declaring it would make the entries that carry the mechanism's only controlled evidence
// fail to load. The loader owns what is unconditional (the status enum, shape, levels);
// `meta verify` owns the status-conditional resolution, where the severity depends on data.

import type { MetaDataTypeProvider } from "../../provider.js";
import type { TypeRegistry, TypeId } from "../../registry.js";
import { applyProviderDefinition, type FactoryMap } from "../../provider-data.js";
import { MetaRequirement } from "./meta-requirement.js";
import { REQUIREMENT_DEFINITION } from "./requirement-definition.embedded.js";

/** The requirements pack's provider id (a logical id, shared by every port). */
export const REQUIREMENTS_PROVIDER_ID = "metaobjects-requirements";

export const requirementsProvider: MetaDataTypeProvider = {
  id: REQUIREMENTS_PROVIDER_ID,
  dependencies: ["metaobjects-core-types"],
  description:
    "Requirements: requirement.functional and requirement.architectural, declared at the document root and checked by meta verify.",
  registerTypes(registry: TypeRegistry): void {
    const factories: FactoryMap = {};
    for (const def of REQUIREMENT_DEFINITION.types ?? []) {
      factories[`${def.type}.${def.subType}`] = (typeId: TypeId, name: string) =>
        new MetaRequirement(typeId, name);
    }
    applyProviderDefinition(registry, REQUIREMENT_DEFINITION, factories);
  },
};
