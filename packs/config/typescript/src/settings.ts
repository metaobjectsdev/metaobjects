/**
 * What the model says about settings and vaults, read once for every generator in the pack.
 *
 * Accessors are the resolving ones (`attr`, `fields`, `children`; ADR-0039), so a setting
 * inherited through `extends` is read like one declared in place. Problems a loader cannot
 * see (a name collision across groups, a secret with a default) are collected and thrown
 * together, each naming the node, so one `meta gen` lists them all.
 */
import { TYPE_OBJECT, toSnakeCase, type AttrValue, type MetaData, type MetaObject } from "@metaobjectsdev/metadata";
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
import { isVault, isVaultScope } from "./nodes.js";

const ATTR_REQUIRED = "required";
const ATTR_DEFAULT = "default";
const ATTR_DESCRIPTION = "description";

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
export function envText(v: AttrValue): string {
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
      if (declared !== undefined && !ENV_NAME_PATTERN.test(declared)) {
        problems.push(`${where}: @envName "${declared}" is not an environment variable name (upper case letters, digits and _, not starting with a digit)`);
      }
      const other = seen.get(envName);
      if (other !== undefined) problems.push(`${where}: environment variable ${envName} is also ${other}`);
      else seen.set(envName, where);
      if (f.resolvedIsArray()) problems.push(`${where}: a setting holds one value; @isArray is not supported`);
      const secret = f.attr(FIELD_ATTR_SECRET) === true;
      const def = f.attr(ATTR_DEFAULT);
      if (secret && def !== undefined) problems.push(`${where}: a @secret setting may not declare @default (its value belongs in the vault)`);
      const description = text(f.attr(ATTR_DESCRIPTION));
      settings.push({
        envName,
        setting: where,
        type: f.typeId.subType,
        required: f.attr(ATTR_REQUIRED) === true,
        secret,
        phase: f.attr(FIELD_ATTR_PHASE) === PHASE_BUILD ? PHASE_BUILD : PHASE_RUNTIME,
        ...(def !== undefined && !secret ? { default: envText(def) } : {}),
        ...(description !== undefined ? { description } : {}),
      });
    }
    const description = text(o.attr(ATTR_DESCRIPTION));
    groups.push({ name: o.name, key, ...(description !== undefined ? { description } : {}), settings });
  }
  if (problems.length > 0) throw new ConfigModelError(problems);
  return groups;
}

/** Every vault declared at the root, in model order. Throws a {@link ConfigModelError} listing every problem. */
export function readVaults(root: MetaData): Vault[] {
  const problems: string[] = [];
  const out: Vault[] = [];
  for (const v of root.children()) {
    if (!isVault(v)) continue;
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
