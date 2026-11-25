/**
 * @metaobjectsdev/pack-cloudflare — the cloudflare pack (ADR-0069): deployment.worker,
 * deployment.pages and the Worker's cloudflare.* bindings, and the generators that turn them
 * into `wrangler.jsonc` and the deploy scripts beside it.
 *
 *   import { provider as cloudflareProvider, cloudflareFiles } from "@metaobjectsdev/pack-cloudflare";
 *   export default defineConfig({ providers: [..., cloudflareProvider], generators: [...cloudflareFiles()] });
 */
import { applyProviderDefinition, type MetaDataTypeProvider, type ProviderDefinition } from "@metaobjectsdev/metadata";
import { DELIVERY_PROVIDER_ID, TYPE_DEPLOYMENT, validateDeployment } from "@metaobjectsdev/pack-delivery";
import { packTypeMaps } from "@metaobjectsdev/pack-systems";
import definition from "../../metamodel/cloudflare.json" with { type: "json" };
import { CLOUDFLARE_PROVIDER_ID } from "./constants.js";

export * from "./constants.js";
export {
  CloudflareModelError,
  GENERATED_WRANGLER_KEYS,
  bindingName,
  isCloudflareDeployment,
  readCloudflare,
  workerName,
  type CloudflareApp,
  type CloudflareAssets,
  type CloudflareBinding,
  type CloudflareBuild,
  type CloudflareCron,
  type CloudflareDeployment,
  type CloudflareVar,
  type PagesDeployment,
  type ReadCloudflareOptions,
  type UnexpressedFact,
  type VaultPlace,
  type WorkerDeployment,
} from "./model.js";
export { parseGeneratedJsonc, renderWrangler } from "./wrangler.js";
export { renderDeploy, renderDoctor, renderRunner, renderSyncSecrets, renderUnexpressed, sh, type CloudflarePaths } from "./files.js";
export {
  cloudflareDeployScript,
  cloudflareDoctorScript,
  cloudflareFiles,
  cloudflareRunnerScript,
  cloudflareSyncSecretsScript,
  cloudflareUnexpressedFile,
  resolvePaths,
  wranglerConfigFile,
  type CloudflareGeneratorOptions,
} from "./generators.js";

export const CLOUDFLARE_DEFINITION = definition as ProviderDefinition;

export const provider: MetaDataTypeProvider = {
  id: CLOUDFLARE_PROVIDER_ID,
  dependencies: ["metaobjects-core-types", DELIVERY_PROVIDER_ID],
  description: "Cloudflare: deployment.worker, deployment.pages and the cloudflare.* bindings of a Worker.",
  registerTypes(registry) {
    const { factories, validators } = packTypeMaps(CLOUDFLARE_DEFINITION, { [TYPE_DEPLOYMENT]: validateDeployment });
    applyProviderDefinition(registry, CLOUDFLARE_DEFINITION, factories, validators);
  },
};
