/**
 * @metaobjectsdev/pack-config — the config pack (ADR-0069): settings, secrets and vaults.
 *
 *   import { configProvider, envExampleFile, keyManifestFile, keysAxiTomlFile } from "@metaobjectsdev/pack-config";
 *   export default defineConfig({ providers: [configProvider], generators: [envExampleFile(), ...] });
 */
export { configProvider, configProvider as provider } from "./provider.js";
export * from "./constants.js";
export { MetaVault, MetaVaultScope, isVault, isVaultScope } from "./nodes.js";
export {
  ConfigModelError,
  deriveEnvName,
  isSettings,
  misplacedSettingAttrs,
  readSettings,
  readVaults,
  type Setting,
  type SettingsGroup,
  type Vault,
  type VaultScope,
} from "./settings.js";
export {
  envExampleFile,
  keyManifestFile,
  keysAxiTomlFile,
  renderEnvExample,
  renderKeyManifest,
  renderKeysAxiToml,
  type ConfigGeneratorOptions,
  type KeysAxiTomlOptions,
} from "./generators.js";
