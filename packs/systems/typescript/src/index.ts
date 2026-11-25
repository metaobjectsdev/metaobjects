// @metaobjectsdev/pack-systems: what exists and what talks to what (ADR-0069 independent
// pack). The vocabulary is metamodel/systems.json; this module registers it and adds the
// one check the data cannot express, that an app's @needs and @calls name real nodes.

import {
  applyProviderDefinition,
  MetaData,
  type FactoryMap,
  type MetaDataTypeProvider,
  type NodeValidator,
  type ProviderDefinition,
  type TypeId,
  type TypeRegistry,
  type ValidatorMap,
} from "@metaobjectsdev/metadata";
import definition from "../../metamodel/systems.json" with { type: "json" };
import {
  APP_ATTR_CALLS,
  APP_ATTR_NEEDS,
  ERR_SYSTEMS_UNRESOLVED_REF,
  SYSTEMS_PROVIDER_ID,
  SYSTEM_SUBTYPE_EXTERNAL,
  TYPE_APP,
  TYPE_RESOURCE,
  TYPE_SYSTEM,
} from "./constants.js";
import { checkRefs } from "./refs.js";

export * from "./constants.js";
export { checkRefs, refList, resolveSystemRef } from "./refs.js";

/** A node of this pack's vocabulary. Its attributes are read with the resolving accessors. */
export class MetaSystemNode extends MetaData {}

export const SYSTEMS_DEFINITION = definition as ProviderDefinition;

const validateApp: NodeValidator = (node, ctx) => {
  const error = ctx.error.bind(ctx);
  checkRefs(node, APP_ATTR_NEEDS, [TYPE_RESOURCE], ERR_SYSTEMS_UNRESOLVED_REF, error);
  checkRefs(node, APP_ATTR_CALLS, [TYPE_APP, `${TYPE_SYSTEM}.${SYSTEM_SUBTYPE_EXTERNAL}`], ERR_SYSTEMS_UNRESOLVED_REF, error);
};

/** A factory for every type a definition declares, and a validator for each of `validated`'s types. */
export function packTypeMaps(
  data: ProviderDefinition,
  validated: Readonly<Record<string, NodeValidator>>,
): { factories: FactoryMap; validators: ValidatorMap } {
  const factories: FactoryMap = {};
  const validators: ValidatorMap = {};
  for (const def of data.types ?? []) {
    const key = `${def.type}.${def.subType}`;
    factories[key] = (typeId: TypeId, name: string) => new MetaSystemNode(typeId, name);
    const validate = validated[def.type];
    if (validate !== undefined) validators[key] = validate;
  }
  return { factories, validators };
}

export const provider: MetaDataTypeProvider = {
  id: SYSTEMS_PROVIDER_ID,
  dependencies: ["metaobjects-core-types"],
  description: "Systems: system.internal / system.external, app.service / app.client / app.job and resource.*.",
  registerTypes(registry: TypeRegistry): void {
    const { factories, validators } = packTypeMaps(SYSTEMS_DEFINITION, { [TYPE_APP]: validateApp });
    applyProviderDefinition(registry, SYSTEMS_DEFINITION, factories, validators);
  },
};
