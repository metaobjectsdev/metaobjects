/**
 * What the model says about settings and vaults, read once for every generator in the pack.
 *
 * Accessors are the resolving ones (`attr`, `fields`, `children`; ADR-0039), so a setting
 * inherited through `extends` is read like one declared in place. Problems a loader cannot
 * see (a name collision across groups, a secret with a default) are collected and thrown
 * together, each naming the node, so one `meta gen` lists them all.
 */
import {
  DOC_ATTR_DESCRIPTION,
  FIELD_ATTR_DEFAULT,
  FIELD_ATTR_REQUIRED,
  TYPE_OBJECT,
  toSnakeCase,
  type AttrValue,
  type MetaData,
  type MetaObject,
} from "@metaobjectsdev/metadata";
import {
  ENV_NAME_PATTERN,
  FIELD_ATTR_ENV_NAME,
  FIELD_ATTR_PHASE,
  FIELD_ATTR_SECRET,
  OBJECT_SUBTYPE_SETTINGS,
  PHASE_BUILD,
  PHASE_RUNTIME,
  SCOPE_ATTR_ENV,
  SCOPE_ATTR_PROJECT,
  VAULT_ATTR_DEFAULT_SCOPE,
  type Phase,
} from "./constants.js";
import { CONFIG_DEFINITION } from "./config-definition.embedded.js";
import { isVault, isVaultScope } from "./nodes.js";

const SETTINGS_FIELD_SUBTYPES: readonly string[] = (() => {
  const rule = CONFIG_DEFINITION.types
    .find((t) => t.type === TYPE_OBJECT && t.subType === OBJECT_SUBTYPE_SETTINGS)
    ?.children.find((c) => c.type === "field");
  return typeof rule?.subType === "string" ? [rule.subType] : (rule?.subType ?? []);
})();

export interface Setting {
  /** The environment variable: `@envName`, else `<GROUP>_<FIELD>` in upper snake case. */
  readonly envName: string;
  /** `<group resolution key>.<field>`, the setting's name in the model. */
  readonly setting: string;
  /** The field subtype: string, int, boolean, ... */
  readonly type: string;
  readonly required: boolean;
  readonly secret: boolean;
  readonly phase: Phase;
  /** The `@default`, as the text an environment variable would hold. Never set on a secret. */
  readonly default?: string;
  readonly description?: string;
}

export interface SettingsGroup {
  readonly name: string;
  readonly key: string;
  readonly description?: string;
  readonly settings: readonly Setting[];
}

export interface VaultScope {
  /** The environment's name in the model. */
  readonly name: string;
  /** The store's place for it (an Infisical project). */
  readonly project: string;
  /** The store's environment slug. */
  readonly env: string;
}

export interface Vault {
  readonly name: string;
  readonly key: string;
  /** The vault subtype: the product (infisical). */
  readonly product: string;
  readonly defaultScope?: VaultScope;
  readonly scopes: readonly VaultScope[];
}

/** Thrown with every problem found, one per line, each naming its node. */
export class ConfigModelError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`config pack: ${problems.length} problem(s) in the model:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigModelError";
  }
}

export function isSettings(o: MetaData): boolean {
  return o.typeId.type === TYPE_OBJECT && o.typeId.subType === OBJECT_SUBTYPE_SETTINGS;
}

function text(v: AttrValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** An attribute value as the text an environment variable holds. */
function envText(v: AttrValue): string {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
}

/** `Database` + `poolSize` → `DATABASE_POOL_SIZE`. */
export function deriveEnvName(group: string, field: string): string {
  return `${toSnakeCase(group)}_${toSnakeCase(field)}`.toUpperCase();
}

/**
 * Every settings group among `objects`, in model order, with its settings in declared
 * order. Throws a {@link ConfigModelError} listing every problem.
 */
export function readSettings(objects: readonly MetaObject[]): SettingsGroup[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  const groups: SettingsGroup[] = [];
  for (const o of objects) {
    if (!isSettings(o)) continue;
    const key = o.resolutionKey();
    const settings: Setting[] = [];
    for (const f of o.fields()) {
      const where = `${key}.${f.name}`;
      const declared = text(f.attr(FIELD_ATTR_ENV_NAME));
      const envName = declared ?? deriveEnvName(o.name, f.name);
      if (!ENV_NAME_PATTERN.test(envName)) {
        problems.push(
          declared !== undefined
            ? `${where}: @envName "${declared}" is not an environment variable name (upper case letters, digits and _, not starting with a digit)`
            : `${where}: the derived environment variable name "${envName}" is not valid (upper case letters, digits and _, not starting with a digit); set @envName`,
        );
      }
      if (!o.isAbstract) {
        const other = seen.get(envName);
        if (other !== undefined) problems.push(`${where}: environment variable ${envName} is also ${other}`);
        else seen.set(envName, where);
      }
      if (!SETTINGS_FIELD_SUBTYPES.includes(f.typeId.subType)) {
        problems.push(`${where}: a setting is a scalar; field.${f.typeId.subType} is not one of ${SETTINGS_FIELD_SUBTYPES.join(", ")}`);
      }
      if (f.resolvedIsArray()) problems.push(`${where}: a setting holds one value; @isArray is not supported`);
      const secret = f.attr(FIELD_ATTR_SECRET) === true;
      const def = f.attr(FIELD_ATTR_DEFAULT);
      if (secret && def !== undefined) problems.push(`${where}: a @secret setting may not declare @default (its value belongs in the vault)`);
      const description = text(f.attr(DOC_ATTR_DESCRIPTION));
      settings.push({
        envName,
        setting: where,
        type: f.typeId.subType,
        required: f.attr(FIELD_ATTR_REQUIRED) === true,
        secret,
        phase: f.attr(FIELD_ATTR_PHASE) === PHASE_BUILD ? PHASE_BUILD : PHASE_RUNTIME,
        ...(def !== undefined && !secret ? { default: envText(def) } : {}),
        ...(description !== undefined ? { description } : {}),
      });
    }
    const description = text(o.attr(DOC_ATTR_DESCRIPTION));
    // An abstract group is a base other groups extend: checked here, listed under its extenders.
    if (!o.isAbstract) groups.push({ name: o.name, key, ...(description !== undefined ? { description } : {}), settings });
  }
  if (problems.length > 0) throw new ConfigModelError(problems);
  return groups;
}

/**
 * Where a model puts `@secret`, `@envName` or `@phase` on a field of something other than a
 * settings group: they load there (every field subtype carries them) and nothing reads them.
 */
export function misplacedSettingAttrs(objects: readonly MetaObject[]): string[] {
  const out: string[] = [];
  for (const o of objects) {
    if (isSettings(o)) continue;
    for (const f of o.fields()) {
      const names = [FIELD_ATTR_SECRET, FIELD_ATTR_ENV_NAME, FIELD_ATTR_PHASE].filter((a) => f.attr(a) !== undefined);
      if (names.length > 0) out.push(`${o.resolutionKey()}.${f.name}: ${names.map((a) => `@${a}`).join(", ")} only mean something on a field of an object.settings; here nothing reads them`);
    }
  }
  return out;
}

/** Every vault declared at the root, in model order. Throws a {@link ConfigModelError} listing every problem. */
export function readVaults(root: MetaData, inScope: (key: string) => boolean = () => true): Vault[] {
  const problems: string[] = [];
  const out: Vault[] = [];
  for (const v of root.children()) {
    if (!isVault(v) || !inScope(v.resolutionKey())) continue;
    const key = v.resolutionKey();
    const scopes: VaultScope[] = [];
    const bySlug = new Map<string, string>();
    for (const s of v.children()) {
      if (!isVaultScope(s)) continue;
      const scope: VaultScope = {
        name: s.name,
        project: text(s.attr(SCOPE_ATTR_PROJECT)) ?? "",
        env: text(s.attr(SCOPE_ATTR_ENV)) ?? s.name,
      };
      const clash = bySlug.get(scope.env);
      if (clash !== undefined) problems.push(`${key}: scopes ${clash} and ${s.name} both use the store environment "${scope.env}"`);
      else bySlug.set(scope.env, s.name);
      scopes.push(scope);
    }
    if (scopes.length === 0) problems.push(`${key}: a vault needs at least one scope.env, one per environment that reads it`);
    const defaultName = text(v.attr(VAULT_ATTR_DEFAULT_SCOPE));
    const defaultScope = defaultName === undefined ? undefined : scopes.find((s) => s.name === defaultName);
    if (defaultName !== undefined && defaultScope === undefined) {
      problems.push(`${key}: @defaultScope "${defaultName}" names no scope.env of this vault (${scopes.map((s) => s.name).join(", ")})`);
    }
    out.push({ name: v.name, key, product: v.typeId.subType, ...(defaultScope !== undefined ? { defaultScope } : {}), scopes });
  }
  if (problems.length > 0) throw new ConfigModelError(problems);
  return out;
}
