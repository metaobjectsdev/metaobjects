// @metaobjectsdev/pack-railway: Railway as a deployment platform (ADR-0069 independent
// pack). It registers `deployment.railway` on the delivery pack's `deployment.base`, and
// holds it to the delivery pack's deployment references. Vocabulary only so far: the
// `.railway/railway.ts` emitter, the secret sync and the deploy scripts come later.

import { applyProviderDefinition, type MetaDataTypeProvider, type ProviderDefinition, type TypeRegistry } from "@metaobjectsdev/metadata";
import { DELIVERY_PROVIDER_ID, TYPE_DEPLOYMENT, validateDeployment } from "@metaobjectsdev/pack-delivery";
import { packTypeMaps } from "@metaobjectsdev/pack-systems";
import definition from "../../metamodel/railway.json" with { type: "json" };

export const RAILWAY_PROVIDER_ID = "metaobjects-railway";
export const DEPLOYMENT_SUBTYPE_RAILWAY = "railway";
export const RAILWAY_ATTR_PROJECT = "project";
export const RAILWAY_ATTR_SERVICE = "service";

export const RAILWAY_DEFINITION = definition as ProviderDefinition;

export const provider: MetaDataTypeProvider = {
  id: RAILWAY_PROVIDER_ID,
  dependencies: ["metaobjects-core-types", DELIVERY_PROVIDER_ID],
  description: "Railway: deployment.railway.",
  registerTypes(registry: TypeRegistry): void {
    const { factories, validators } = packTypeMaps(RAILWAY_DEFINITION, { [TYPE_DEPLOYMENT]: validateDeployment });
    applyProviderDefinition(registry, RAILWAY_DEFINITION, factories, validators);
  },
};
