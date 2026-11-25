/** The config pack's metamodel strings: one definition each (the project's constants rule). */

/** The provider id; pack.json's `id`. */
export const CONFIG_PROVIDER_ID = "metaobjects-config";

export const OBJECT_SUBTYPE_SETTINGS = "settings";

export const TYPE_VAULT = "vault";
export const VAULT_SUBTYPE_INFISICAL = "infisical";
export const VAULT_ATTR_DEFAULT_SCOPE = "defaultScope";

export const TYPE_SCOPE = "scope";
export const SCOPE_SUBTYPE_ENV = "env";
export const SCOPE_ATTR_PROJECT = "project";
export const SCOPE_ATTR_ENV = "env";

export const FIELD_ATTR_SECRET = "secret";
export const FIELD_ATTR_ENV_NAME = "envName";
export const FIELD_ATTR_PHASE = "phase";

export const PHASE_RUNTIME = "runtime";
export const PHASE_BUILD = "build";
export const PHASES = [PHASE_RUNTIME, PHASE_BUILD] as const;
export type Phase = (typeof PHASES)[number];

/** What an environment variable name may be: upper case, digits and underscores, no leading digit. */
export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
