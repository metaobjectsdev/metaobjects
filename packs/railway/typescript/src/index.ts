/**
 * @metaobjectsdev/pack-railway — the railway pack (ADR-0069): deployment.railway, and the
 * generators that turn it into Railway's `.railway/railway.ts` and the scripts beside it.
 *
 *   import { provider as railwayProvider, railwayFiles } from "@metaobjectsdev/pack-railway";
 *   export default defineConfig({ providers: [..., railwayProvider], generators: [...railwayFiles()] });
 */
import { applyProviderDefinition, type MetaDataTypeProvider, type ProviderDefinition } from "@metaobjectsdev/metadata";
import { DELIVERY_PROVIDER_ID, TYPE_DEPLOYMENT, validateDeployment } from "@metaobjectsdev/pack-delivery";
import { packTypeMaps } from "@metaobjectsdev/pack-systems";
import definition from "../../metamodel/railway.json" with { type: "json" };
import { RAILWAY_PROVIDER_ID } from "./constants.js";

export * from "./constants.js";
export {
  RailwayModelError,
  isRailwayDeployment,
  pickProject,
  readRailway,
  type RailwayBuild,
  type RailwayDeployment,
  type RailwayProcess,
  type RailwayProject,
  type RailwayResource,
  type RailwayVariable,
  type ReadRailwayOptions,
} from "./model.js";
export { renderRailwayTs } from "./railway-ts.js";
export { renderDeploy, renderDeploySkill, renderDoctor, renderSyncSecrets, renderUnexpressed, unexpressedFacts } from "./files.js";
export {
  railwayDeployScript,
  railwayDeploySkill,
  railwayDoctorScript,
  railwayFiles,
  railwaySyncSecretsScript,
  railwayTsFile,
  railwayUnexpressedFile,
  type RailwayGeneratorOptions,
} from "./generators.js";

export const RAILWAY_DEFINITION = definition as ProviderDefinition;

export const provider: MetaDataTypeProvider = {
  id: RAILWAY_PROVIDER_ID,
  dependencies: ["metaobjects-core-types", DELIVERY_PROVIDER_ID],
  description: "Railway: deployment.railway.",
  registerTypes(registry) {
    const { factories, validators } = packTypeMaps(RAILWAY_DEFINITION, { [TYPE_DEPLOYMENT]: validateDeployment });
    applyProviderDefinition(registry, RAILWAY_DEFINITION, factories, validators);
  },
};
