// ADR-0066 — the project settings the business-rules vocabulary reads, from the `rules`
// and `verify` blocks of `.metaobjects/config.json`. Every port reads the same keys with
// the same defaults. A key that is absent takes its default, which is always the
// behaviour a project had before the setting existed: no project declared an operation or
// a transition before 1.3.0, so every default here is the safe one.

/** `rules.permissions.names`: how strongly `verify` asks for an explicit `@permission`.
 *  `derive` (default) says nothing, `advise` warns, `require` fails the build. */
export const RULES_PERMISSION_NAMES = ["derive", "advise", "require"] as const;
export type RulesPermissionNames = (typeof RULES_PERMISSION_NAMES)[number];

/** `rules.lifecycle.create`: whether a create may start a row in any state (`any`) or only
 *  in the initial one (`initial`, default). No effect yet: validated and stored, and read by
 *  nothing until the enforcing shells land. */
export const RULES_LIFECYCLE_CREATE = ["initial", "any"] as const;
export type RulesLifecycleCreate = (typeof RULES_LIFECYCLE_CREATE)[number];

/** `rules.lifecycle.commands`: which transitions derive a command of their own.
 *  `unclaimed` (default): those no declared command lists in `@transitions`. */
export const RULES_LIFECYCLE_COMMANDS = ["unclaimed", "all", "none"] as const;
export type RulesLifecycleCommands = (typeof RULES_LIFECYCLE_COMMANDS)[number];

/** `verify.lifecycle.unreachable`: the severity of an unreachable state, and of a
 *  transition that starts only from unreachable states. `warn` (default), `error`, `off`. */
export const VERIFY_LIFECYCLE_UNREACHABLE = ["warn", "error", "off"] as const;
export type VerifyLifecycleUnreachable = (typeof VERIFY_LIFECYCLE_UNREACHABLE)[number];

/** The resolved settings, every absent key at its default. */
export interface RulesSettings {
  readonly permissionNames: RulesPermissionNames;
  readonly lifecycleCreate: RulesLifecycleCreate;
  readonly lifecycleCommands: RulesLifecycleCommands;
  readonly lifecycleUnreachable: VerifyLifecycleUnreachable;
}

export const DEFAULT_RULES_SETTINGS: RulesSettings = {
  permissionNames: "derive",
  lifecycleCreate: "initial",
  lifecycleCommands: "unclaimed",
  lifecycleUnreachable: "warn",
};

/** The `rules` and `verify` config blocks as written; every key optional. */
export interface RulesConfigBlocks {
  readonly rules?: {
    readonly permissions?: { readonly names?: RulesPermissionNames | undefined } | undefined;
    readonly lifecycle?: {
      readonly create?: RulesLifecycleCreate | undefined;
      readonly commands?: RulesLifecycleCommands | undefined;
    } | undefined;
  } | undefined;
  readonly verify?: {
    readonly lifecycle?: { readonly unreachable?: VerifyLifecycleUnreachable | undefined } | undefined;
  } | undefined;
}

/**
 * The settings of the project a node was loaded for: the root's `rulesSettings`, which the
 * project-aware load sets from `.metaobjects/config.json` (as it sets `naming` and `wire`). A tree
 * loaded with no project has the defaults. Generators read this; `meta verify` reads the same
 * settings from its collection.
 */
export function rulesSettingsOfModel(node: { root(): unknown }): RulesSettings {
  return (node.root() as { rulesSettings?: RulesSettings | undefined }).rulesSettings ?? DEFAULT_RULES_SETTINGS;
}

/** The settings a config declares, each absent key at its default. */
export function rulesSettingsOf(cfg: RulesConfigBlocks): RulesSettings {
  return {
    permissionNames: cfg.rules?.permissions?.names ?? DEFAULT_RULES_SETTINGS.permissionNames,
    lifecycleCreate: cfg.rules?.lifecycle?.create ?? DEFAULT_RULES_SETTINGS.lifecycleCreate,
    lifecycleCommands: cfg.rules?.lifecycle?.commands ?? DEFAULT_RULES_SETTINGS.lifecycleCommands,
    lifecycleUnreachable: cfg.verify?.lifecycle?.unreachable ?? DEFAULT_RULES_SETTINGS.lifecycleUnreachable,
  };
}
