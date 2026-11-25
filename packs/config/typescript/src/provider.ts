/**
 * The config pack's provider (ADR-0069): an independent pack, outside the default bundle.
 * A project opts in by naming it (`defineConfig({ providers: [configProvider] })`).
 *
 * It owns `object.settings`, `vault.infisical` and `scope.env`, lets `metadata.root` hold a
 * vault, and adds the optional `@secret`, `@envName` and `@phase` attributes to every field
 * subtype registered when it is composed. Leave it out and all of these are unknown to the
 * loader, which refuses a model that uses them by name.
 */
import { MetaObject, TYPE_OBJECT, type MetaDataTypeProvider } from "@metaobjectsdev/metadata";
import { CONFIG_DEFINITION } from "./config-definition.embedded.js";
import { CONFIG_PROVIDER_ID, OBJECT_SUBTYPE_SETTINGS, SCOPE_SUBTYPE_ENV, TYPE_SCOPE, TYPE_VAULT, VAULT_SUBTYPE_INFISICAL } from "./constants.js";
import { registerDefinition } from "./definition.js";
import { MetaVault, MetaVaultScope } from "./nodes.js";

export const configProvider: MetaDataTypeProvider = {
  id: CONFIG_PROVIDER_ID,
  // After core-types: `field.*` in the definition's `extends` means the field subtypes
  // registered by then.
  dependencies: ["metaobjects-core-types"],
  description:
    "Settings and secrets (config pack): object.settings, @secret / @envName / @phase on fields, vault.infisical and scope.env.",
  registerTypes(registry) {
    registerDefinition(registry, CONFIG_DEFINITION, {
      [`${TYPE_OBJECT}.${OBJECT_SUBTYPE_SETTINGS}`]: (typeId, name) => new MetaObject(typeId, name),
      [`${TYPE_VAULT}.${VAULT_SUBTYPE_INFISICAL}`]: (typeId, name) => new MetaVault(typeId, name),
      [`${TYPE_SCOPE}.${SCOPE_SUBTYPE_ENV}`]: (typeId, name) => new MetaVaultScope(typeId, name),
    });
  },
};
