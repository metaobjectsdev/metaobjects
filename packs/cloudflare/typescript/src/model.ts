/**
 * What the model says about Cloudflare, read once for every generator in the pack.
 *
 * A deployment.worker or deployment.pages names its app and environment; the app holds the
 * facts true everywhere (its build, the settings groups it reads, the resources it needs);
 * the deployment adds what differs per environment. The facts every environment shares sit on
 * an abstract deployment each environment's deployment `extends`, so they are read through
 * the resolving accessors (ADR-0039) like a fact declared in place, and so is an estate
 * overlay. Abstract deployments are bases, never deployed: they are skipped here.
 *
 * Problems a loader cannot see (a binding for a resource the app does not need, a resource
 * with no binding in some environment, a required setting with no value) are collected and
 * thrown together, each naming its node.
 */
import { toSnakeCase, type MetaData, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import {
  ConfigModelError,
  PHASE_BUILD,
  VAULT_SUBTYPE_INFISICAL,
  readSettings,
  readVaults,
  type Setting,
  type SettingsGroup,
  type Vault,
  type VaultScope,
} from "@metaobjectsdev/pack-config";
import {
  BUILD_SUBTYPE_STATIC,
  DEPLOYMENT_ATTR_APP,
  DEPLOYMENT_ATTR_BRANCH,
  DEPLOYMENT_ATTR_DOMAINS,
  DEPLOYMENT_ATTR_ENVIRONMENT,
  DEPLOYMENT_ATTR_REGION,
  DEPLOYMENT_ATTR_REPLICAS,
  DEPLOYMENT_ATTR_SECRETS,
  TYPE_BUILD,
  TYPE_DEPLOYMENT,
  TYPE_ENVIRONMENT,
  TYPE_RUNTIME,
  TYPE_VALUE,
  VALUE_ATTR_LITERAL,
  VALUE_ATTR_OUTPUT,
  VALUE_ATTR_PRODUCED_BY,
  VALUE_ATTR_SETTING,
  VALUE_SUBTYPE_LITERAL,
} from "@metaobjectsdev/pack-delivery";
import {
  APP_ATTR_NEEDS,
  APP_ATTR_SCHEDULE,
  APP_ATTR_SETTINGS,
  APP_SUBTYPE_JOB,
  TYPE_APP,
  TYPE_RESOURCE,
  refList,
  resolveSystemRef,
} from "@metaobjectsdev/pack-systems";
import {
  ATTR_TOKEN_SECRET,
  ATTR_TOKEN_VAULT,
  BINDING_D1,
  BINDING_KV,
  BINDING_QUEUE,
  BINDING_R2,
  BINDING_RATELIMIT,
  D1_ATTR_DATABASE_ID,
  D1_ATTR_DATABASE_NAME,
  D1_ATTR_MIGRATIONS_DIR,
  DEPLOYMENT_SUBTYPE_PAGES,
  DEPLOYMENT_SUBTYPE_WORKER,
  KV_ATTR_NAMESPACE_ID,
  PAGES_ATTR_PROJECT,
  QUEUE_ATTR_QUEUE,
  R2_ATTR_BUCKET_NAME,
  RATELIMIT_ATTR_LIMIT,
  RATELIMIT_ATTR_NAMESPACE_ID,
  RATELIMIT_ATTR_PERIOD,
  RATELIMIT_PERIODS,
  TYPE_CLOUDFLARE,
  WORKER_ATTR_ASSETS_BINDING,
  WORKER_ATTR_COMPATIBILITY_DATE,
  WORKER_ATTR_COMPATIBILITY_FLAGS,
  WORKER_ATTR_EXTRA,
  WORKER_ATTR_JOBS,
  WORKER_ATTR_MAIN,
  WORKER_ATTR_NOT_FOUND,
  WORKER_ATTR_SCRIPT,
  WORKER_ATTR_WORKERS_DEV,
  WORKER_ATTR_WORKER_FIRST,
  WORKER_ATTR_WORKER_FIRST_PATHS,
} from "./constants.js";
import { bindableKinds, bindingKindFor, describeResource, isExternal, resourceKindOf } from "./resources.js";

/** Thrown with every problem found, one per line, each naming its node. */
export class CloudflareModelError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`cloudflare pack: ${problems.length} problem(s) in the model:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "CloudflareModelError";
  }
}

/** A fact and the model node it comes from, for the comment beside it. */
interface Traced {
  readonly from: string;
}

/** One entry of the Worker's `vars`. */
export interface CloudflareVar extends Traced {
  readonly name: string;
  readonly value: string;
}

export type CloudflareBinding = Traced & { readonly binding: string } & (
    | { readonly kind: typeof BINDING_D1; readonly databaseName: string; readonly databaseId?: string; readonly migrationsDir?: string }
    | { readonly kind: typeof BINDING_KV; readonly namespaceId: string }
    | { readonly kind: typeof BINDING_R2; readonly bucketName: string }
    | { readonly kind: typeof BINDING_QUEUE; readonly queue: string }
    | { readonly kind: typeof BINDING_RATELIMIT; readonly namespaceId: string; readonly limit: number; readonly period: number }
  );

export interface CloudflareCron extends Traced {
  readonly schedule: string;
}

export interface CloudflareAssets {
  readonly directory: string;
  readonly binding?: string;
  readonly notFound?: string;
  /** true: every request; a list: those patterns. */
  readonly workerFirst?: true | readonly string[];
}

/** The app's build, as the deploy script runs it. */
export interface CloudflareBuild {
  readonly kind: string;
  readonly command?: string;
  readonly directory?: string;
  readonly from: string;
}

/** A fact the generated files do not carry, and how it is carried instead. */
export interface UnexpressedFact {
  readonly fact: string;
  readonly how: string;
}

/** Where a secret or the deploy token is read from. */
export interface VaultPlace {
  readonly key: string;
  readonly scope: VaultScope;
}

interface DeploymentCommon {
  readonly key: string;
  readonly environment: string;
  readonly domains: readonly string[];
  readonly branch?: string;
  readonly build?: CloudflareBuild;
  /** The environment variables of the app's secret runtime settings, in model order. */
  readonly secrets: readonly string[];
  /** The app's non-secret build-time settings that have a value here: deploy.sh exports them before the build. */
  readonly buildVars: readonly CloudflareVar[];
  /** Where those secrets are read from at deploy. Absent when the app reads none. */
  readonly vault?: VaultPlace;
  readonly token: { readonly secret: string; readonly place: VaultPlace };
  readonly unexpressed: readonly UnexpressedFact[];
}

export interface WorkerDeployment extends DeploymentCommon {
  readonly kind: typeof DEPLOYMENT_SUBTYPE_WORKER;
  /** The Worker's name as the model gives it (@script, else the app's name); the env block may suffix it. */
  readonly script: string;
  readonly main?: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly string[];
  readonly workersDev?: boolean;
  readonly assets?: CloudflareAssets;
  readonly crons: readonly CloudflareCron[];
  readonly vars: readonly CloudflareVar[];
  readonly bindings: readonly CloudflareBinding[];
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface PagesDeployment extends DeploymentCommon {
  readonly kind: typeof DEPLOYMENT_SUBTYPE_PAGES;
  readonly project: string;
  readonly directory: string;
}

export type CloudflareDeployment = WorkerDeployment | PagesDeployment;

/** One app's Cloudflare deployments: what one wrangler.jsonc and one set of scripts declare. */
export interface CloudflareApp {
  readonly name: string;
  /** `app.service Shop.site`, for comments. */
  readonly appKey: string;
  readonly kind: typeof DEPLOYMENT_SUBTYPE_WORKER | typeof DEPLOYMENT_SUBTYPE_PAGES;
  /** The concrete deployments, the top-level one first, then the rest in model order. */
  readonly deployments: readonly CloudflareDeployment[];
  /** The environment written at the top level of wrangler.jsonc (`wrangler deploy` with no `--env`). */
  readonly topLevel: string;
}

export interface ReadCloudflareOptions {
  /** The app to read, as `System.app` or the app's name, when the model deploys more than one to Cloudflare. */
  readonly app?: string;
  /** The environment written at the top level of wrangler.jsonc. Absent: the only one, else `production`. */
  readonly topLevel?: string;
}

/** The environment a model with several picks for the top level when no option names one. */
const DEFAULT_TOP_LEVEL = "production";

/** Keys the generator writes itself, which `@extra` may not set. */
export const GENERATED_WRANGLER_KEYS: readonly string[] = [
  "$schema", "name", "main", "compatibility_date", "compatibility_flags", "workers_dev", "assets", "routes", "triggers",
  "vars", "secrets", "d1_databases", "kv_namespaces", "r2_buckets", "queues", "ratelimits", "env",
];

function text(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function int(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

export function isCloudflareDeployment(node: MetaData): boolean {
  return node.type === TYPE_DEPLOYMENT && (node.subType === DEPLOYMENT_SUBTYPE_WORKER || node.subType === DEPLOYMENT_SUBTYPE_PAGES);
}

/** A node's binding name: its name in upper snake case (`rateLimit` is RATE_LIMIT). */
export function bindingName(name: string): string {
  return toSnakeCase(name).toUpperCase();
}

/** `app.service Shop.site`. */
function appKeyOf(app: MetaData): string {
  return `${app.type}.${app.subType} ${app.parent === undefined ? app.resolutionKey() : `${app.parent.resolutionKey()}.${app.name}`}`;
}

/** The settings groups `names` names, reporting each that matches none or several. */
function groupsNamed(names: readonly string[], groups: readonly SettingsGroup[], where: string, problems: string[]): SettingsGroup[] {
  const out: SettingsGroup[] = [];
  for (const n of names) {
    const hits = groups.filter((g) => g.key === n || g.name === n);
    if (hits.length === 1) out.push(hits[0]!);
    else if (hits.length === 0) problems.push(`${where}: @${APP_ATTR_SETTINGS} names "${n}", which is no object.settings in the model`);
    else problems.push(`${where}: @${APP_ATTR_SETTINGS} "${n}" matches ${hits.map((g) => g.key).join(" and ")}; name it by its package`);
  }
  return out;
}

/** The setting `Group.field` names, among every group in the model. */
function settingNamed(ref: string, groups: readonly SettingsGroup[]): Setting | undefined {
  const dot = ref.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const group = ref.slice(0, dot);
  const field = ref.slice(dot + 1);
  const hits = groups.filter((g) => g.key === group || g.name === group);
  if (hits.length !== 1) return undefined;
  return hits[0]!.settings.find((s) => s.setting === `${hits[0]!.key}.${field}`);
}

/** The app's build (resolving, so an inherited build counts), or undefined. */
function readBuild(app: MetaData): CloudflareBuild | undefined {
  // ADR-0039: resolving, so a build the app inherits through `extends` counts.
  const b = app.children().find((c) => c.type === TYPE_BUILD);
  if (b === undefined) return undefined;
  const command = text(b.attr("command"));
  const directory = text(b.attr("directory"));
  return { kind: b.subType, from: `build.${b.subType} ${b.name}`, ...(command !== undefined ? { command } : {}), ...(directory !== undefined ? { directory } : {}) };
}

interface Context {
  readonly all: readonly MetaData[];
  readonly groups: readonly SettingsGroup[];
  readonly vaults: readonly Vault[];
}

/** The vault `ref` names and its scope for `env`, or a problem. */
function vaultPlace(ref: string, env: string, attr: string, ctx: Context, where: string, problems: string[]): VaultPlace | undefined {
  const v = ctx.vaults.find((x) => x.name === ref || x.key === ref);
  // The scope named after the environment, else the vault's @defaultScope (one deploy-token scope serving every environment).
  const scope = v?.scopes.find((s) => s.name === env) ?? v?.defaultScope;
  if (v === undefined) problems.push(`${where}: @${attr} "${ref}" names no vault.* in the model`);
  else if (v.product !== VAULT_SUBTYPE_INFISICAL) problems.push(`${where}: vault ${v.key} is vault.${v.product}; the scripts read vault.${VAULT_SUBTYPE_INFISICAL} through keys-axi`);
  else if (scope === undefined) problems.push(`${where}: vault ${v.key} has no scope.env named "${env}" and no @defaultScope, so this environment has no place in it`);
  else return { key: v.key, scope };
  return undefined;
}

/** The deployment of `app` in `env` among the Cloudflare deployments, if any. */
function deploymentOf(app: MetaData, env: MetaData, all: readonly MetaData[]): MetaData | undefined {
  return all.find((d) => {
    const a = refList(d, DEPLOYMENT_ATTR_APP)[0];
    const e = refList(d, DEPLOYMENT_ATTR_ENVIRONMENT)[0];
    return (
      a !== undefined &&
      e !== undefined &&
      resolveSystemRef(d, a, DEPLOYMENT_ATTR_APP, [TYPE_APP]) === app &&
      resolveSystemRef(d, e, DEPLOYMENT_ATTR_ENVIRONMENT, [TYPE_ENVIRONMENT]) === env
    );
  });
}

/**
 * A value.ref as the text Cloudflare is given. Cloudflare resolves no reference at deploy
 * time, so only an address the model itself states can be written: another app's public
 * host or URL, from its Cloudflare deployment's first @domains entry in the same environment.
 */
function referenceValue(value: MetaData, env: MetaData, ctx: Context, where: string, problems: string[]): string | undefined {
  const producedBy = text(value.attr(VALUE_ATTR_PRODUCED_BY)) ?? "";
  const output = text(value.attr(VALUE_ATTR_OUTPUT)) ?? "";
  const target = resolveSystemRef(value, producedBy, VALUE_ATTR_PRODUCED_BY, [TYPE_RESOURCE, TYPE_APP]);
  if (target === undefined) return undefined; // the delivery pack reports it at load
  if (target.type === TYPE_APP && (output === "host" || output === "publicUrl")) {
    const d = deploymentOf(target, env, ctx.all);
    const domain = d === undefined ? undefined : refList(d, DEPLOYMENT_ATTR_DOMAINS)[0];
    if (domain !== undefined) return output === "host" ? domain : `https://${domain}`;
    problems.push(`${where}: app "${target.name}" has no Cloudflare deployment with @domains in environment ${env.name}, so its ${output} is not known`);
    return undefined;
  }
  problems.push(
    `${where}: Cloudflare resolves no reference at deploy time; a value.ref can only take another Cloudflare-deployed app's host or publicUrl (from its @domains). Bind ${target.type}.${target.subType} "${target.name}" (a cloudflare.* child) or give the setting a value.literal or the vault (@secret)`,
  );
  return undefined;
}

/** ` (from siteBase)` when `child` is declared on a deployment `node` extends rather than on `node` itself. */
function declaredIn(child: MetaData, node: MetaData): string {
  return child.parent !== undefined && child.parent !== node ? ` (from ${child.parent.name})` : "";
}

/** The common part of a deployment, or undefined when its app or environment does not resolve. */
function readCommon(
  node: MetaData,
  ctx: Context,
  problems: string[],
): { app: MetaData; env: MetaData; where: string; settings: Setting[]; common: Omit<DeploymentCommon, "unexpressed" | "token"> & { token?: DeploymentCommon["token"] } } | undefined {
  const where = `deployment.${node.subType} ${node.resolutionKey()}`;
  const appRef = refList(node, DEPLOYMENT_ATTR_APP)[0];
  const envRef = refList(node, DEPLOYMENT_ATTR_ENVIRONMENT)[0];
  const app = appRef === undefined ? undefined : resolveSystemRef(node, appRef, DEPLOYMENT_ATTR_APP, [TYPE_APP]);
  const env = envRef === undefined ? undefined : resolveSystemRef(node, envRef, DEPLOYMENT_ATTR_ENVIRONMENT, [TYPE_ENVIRONMENT]);
  if (app === undefined || env === undefined) return undefined; // the delivery pack reports it at load

  const settings = groupsNamed(refList(app, APP_ATTR_SETTINGS), ctx.groups, appKeyOf(app), problems).flatMap((g) => g.settings);
  // Build-time settings with a value: a value.literal here (resolving, so the base's counts), else the @default.
  const buildVars: CloudflareVar[] = [];
  for (const s of settings.filter((x) => x.phase === PHASE_BUILD && !x.secret)) {
    // ADR-0039: resolving, so a value the abstract base declares counts.
    const v = node.children().find((c) => c.type === TYPE_VALUE && c.subType === VALUE_SUBTYPE_LITERAL && settingNamed(text(c.attr(VALUE_ATTR_SETTING)) ?? "", ctx.groups) === s);
    const literal = v === undefined ? undefined : text(v.attr(VALUE_ATTR_LITERAL));
    if (v !== undefined && literal !== undefined) buildVars.push({ name: s.envName, value: literal, from: `value.literal ${v.name}${declaredIn(v, node)}` });
    else if (s.default !== undefined) buildVars.push({ name: s.envName, value: s.default, from: `${s.setting} @default` });
  }
  const secrets = settings.filter((s) => s.secret && s.phase !== PHASE_BUILD).map((s) => s.envName);
  const secretsRef = text(node.attr(DEPLOYMENT_ATTR_SECRETS));
  let vault: VaultPlace | undefined;
  if (secretsRef !== undefined) vault = vaultPlace(secretsRef, env.name, DEPLOYMENT_ATTR_SECRETS, ctx, where, problems);
  else if (secrets.length > 0) problems.push(`${where}: ${app.name} reads ${secrets.length} secret setting(s) (${secrets.join(", ")}) and the deployment names no vault; set @${DEPLOYMENT_ATTR_SECRETS}`);

  const tokenSecret = text(node.attr(ATTR_TOKEN_SECRET)) ?? "";
  const tokenVaultRef = text(node.attr(ATTR_TOKEN_VAULT)) ?? secretsRef;
  let token: DeploymentCommon["token"] | undefined;
  if (tokenVaultRef === undefined) {
    problems.push(`${where}: the deploy token ${tokenSecret} has no vault: set @${ATTR_TOKEN_VAULT} (or @${DEPLOYMENT_ATTR_SECRETS})`);
  } else {
    const place = vaultPlace(tokenVaultRef, env.name, text(node.attr(ATTR_TOKEN_VAULT)) !== undefined ? ATTR_TOKEN_VAULT : DEPLOYMENT_ATTR_SECRETS, ctx, where, problems);
    if (place !== undefined) token = { secret: tokenSecret, place };
  }

  const build = readBuild(app);
  const branch = text(node.attr(DEPLOYMENT_ATTR_BRANCH));
  return {
    app,
    env,
    where,
    settings,
    common: {
      key: node.resolutionKey(),
      environment: env.name,
      domains: refList(node, DEPLOYMENT_ATTR_DOMAINS),
      ...(branch !== undefined ? { branch } : {}),
      ...(build !== undefined ? { build } : {}),
      secrets,
      buildVars,
      ...(vault !== undefined ? { vault } : {}),
      ...(token !== undefined ? { token } : {}),
    },
  };
}

/** Facts any Cloudflare deployment leaves to something else: processes, replicas, region, watch paths, build-time settings. */
function commonUnexpressed(node: MetaData, app: MetaData, settings: readonly Setting[], secrets: readonly string[], vault: VaultPlace | undefined): UnexpressedFact[] {
  const out: UnexpressedFact[] = [];
  // ADR-0039: resolving, the processes the app effectively has.
  for (const p of app.children().filter((c) => c.type === TYPE_RUNTIME)) {
    const set = ["command", "port", "healthPath", "healthTimeoutSeconds", "drainSeconds", "restart"].filter((a) => p.attr(a) !== undefined);
    if (set.length > 0) {
      out.push({
        fact: `runtime.process \`${p.name}\` (${set.map((a) => `@${a}`).join(", ")})`,
        how: "Cloudflare runs a Worker per request, with no process to start, listen, health-check, drain or restart. Nothing to carry.",
      });
    }
  }
  const replicas = int(node.attr(DEPLOYMENT_ATTR_REPLICAS));
  if (replicas !== undefined) out.push({ fact: `@replicas ${replicas}`, how: "Cloudflare runs a Worker in every location on demand; there is no replica count to set." });
  const region = text(node.attr(DEPLOYMENT_ATTR_REGION));
  if (region !== undefined) out.push({ fact: `@region \`${region}\``, how: "Cloudflare has no region for a Worker or a Pages site. Smart Placement, if wanted, goes in @extra as `placement`." });
  const b = app.children().find((c) => c.type === TYPE_BUILD);
  const watch = b === undefined ? [] : [...refList(b, "watchInclude"), ...refList(b, "watchExclude").map((g) => `!${g}`)];
  if (watch.length > 0) {
    out.push({ fact: `Watch paths ${watch.map((g) => `\`${g}\``).join(", ")}`, how: "Deploys run from deploy/cloudflare/deploy.sh, not on a push, so nothing watches paths. Workers Builds and Pages Git integration keep their build watch paths in the dashboard." });
  }
  const buildPhase = settings.filter((s) => s.phase === PHASE_BUILD).map((s) => s.envName);
  if (buildPhase.length > 0) {
    out.push({
      fact: `Build-time settings ${buildPhase.map((n) => `\`${n}\``).join(", ")}`,
      how: "Read by the build, which runs on the deploying machine: deploy/cloudflare/deploy.sh exports each one the model gives a value (a value already in the environment wins) and runs the build there. They never reach Cloudflare as settings.",
    });
  }
  if (secrets.length > 0 && vault !== undefined) {
    out.push({
      fact: `Secret values: ${secrets.map((n) => `\`${n}\``).join(", ")}`,
      how: `Never in a file. deploy/cloudflare/sync-secrets.sh copies them from the vault scope \`${vault.scope.project}/${vault.scope.env}\`; deploy/cloudflare/doctor.sh checks the names are in the vault and on Cloudflare.`,
    });
  }
  return out;
}

function readWorker(node: MetaData, ctx: Context, problems: string[]): WorkerDeployment | undefined {
  const read = readCommon(node, ctx, problems);
  if (read === undefined) return undefined;
  const { app, env, where, settings, common } = read;
  const unexpressed = commonUnexpressed(node, app, settings, common.secrets, common.vault);

  // vars: each value node, then each non-secret runtime setting's default.
  // ADR-0039: resolving, so a value the abstract base or an estate overlay declares counts.
  const fromValue = new Map<string, CloudflareVar>();
  for (const v of node.children().filter((c) => c.type === TYPE_VALUE)) {
    const vWhere = `${where} value.${v.subType} ${v.name}`;
    const ref = text(v.attr(VALUE_ATTR_SETTING)) ?? "";
    const setting = settingNamed(ref, ctx.groups);
    if (setting === undefined) {
      problems.push(`${vWhere}: @${VALUE_ATTR_SETTING} "${ref}" names no setting (Group.field) of an object.settings in the model`);
      continue;
    }
    if (!settings.includes(setting)) problems.push(`${vWhere}: ${ref} is not a setting of the groups ${app.name} reads (@${APP_ATTR_SETTINGS})`);
    if (setting.secret) {
      problems.push(`${vWhere}: ${ref} is @secret; its value comes from the vault, never from a value node`);
      continue;
    }
    const value = v.subType === VALUE_SUBTYPE_LITERAL ? (text(v.attr(VALUE_ATTR_LITERAL)) ?? "") : referenceValue(v, env, ctx, vWhere, problems);
    if (value !== undefined) fromValue.set(setting.envName, { name: setting.envName, value, from: `value.${v.subType} ${v.name}${declaredIn(v, node)}` });
  }
  // In the order the settings are declared, so a value moving between the base and an environment moves no line.
  const vars = new Map<string, CloudflareVar>();
  const unset: string[] = [];
  for (const s of settings) {
    if (s.secret || s.phase === PHASE_BUILD) continue;
    const given = fromValue.get(s.envName);
    if (given !== undefined) vars.set(s.envName, given);
    else if (s.default !== undefined) vars.set(s.envName, { name: s.envName, value: s.default, from: `${s.setting} @default` });
    else if (s.required) problems.push(`${where}: ${s.setting} (${s.envName}) is required and has no value here: give it a value.literal on the deployment, a @default, or mark it @secret`);
    else unset.push(s.envName);
  }
  if (unset.length > 0) {
    unexpressed.push({ fact: `Optional settings with no value: ${unset.map((n) => `\`${n}\``).join(", ")}`, how: "Not in `vars`, so the Worker reads them as unset. A deploy removes a var the file does not declare: give one a value.literal to set it." });
  }

  // Bindings: each cloudflare.* child (resolving, so the base's bindings count), placed on a resource the app needs.
  const needed = refList(app, APP_ATTR_NEEDS)
    .map((r) => resolveSystemRef(app, r, APP_ATTR_NEEDS, [TYPE_RESOURCE]))
    .filter((r): r is MetaData => r !== undefined);
  const bindings: CloudflareBinding[] = [];
  const bound = new Set<string>();
  for (const b of node.children().filter((c) => c.type === TYPE_CLOUDFLARE)) {
    const bWhere = `${where} cloudflare.${b.subType} ${b.name}`;
    const from = `cloudflare.${b.subType} ${b.name}${declaredIn(b, node)}`;
    bound.add(b.name);
    const binding = bindingName(b.name);
    const resourceKind = resourceKindOf(b.subType);
    if (resourceKind !== undefined && !needed.some((r) => r.name === b.name && r.subType === resourceKind)) {
      problems.push(`${bWhere}: ${app.name} needs no resource.${resourceKind} named "${b.name}" (@${APP_ATTR_NEEDS}); a binding is named after the resource it places`);
    }
    switch (b.subType) {
      case BINDING_D1: {
        const id = text(b.attr(D1_ATTR_DATABASE_ID));
        const dir = text(b.attr(D1_ATTR_MIGRATIONS_DIR));
        bindings.push({ kind: BINDING_D1, binding, from, databaseName: text(b.attr(D1_ATTR_DATABASE_NAME)) ?? "", ...(id !== undefined ? { databaseId: id } : {}), ...(dir !== undefined ? { migrationsDir: dir } : {}) });
        break;
      }
      case BINDING_KV:
        bindings.push({ kind: BINDING_KV, binding, from, namespaceId: text(b.attr(KV_ATTR_NAMESPACE_ID)) ?? "" });
        break;
      case BINDING_R2:
        bindings.push({ kind: BINDING_R2, binding, from, bucketName: text(b.attr(R2_ATTR_BUCKET_NAME)) ?? "" });
        break;
      case BINDING_QUEUE:
        bindings.push({ kind: BINDING_QUEUE, binding, from, queue: text(b.attr(QUEUE_ATTR_QUEUE)) ?? "" });
        break;
      case BINDING_RATELIMIT: {
        const period = int(b.attr(RATELIMIT_ATTR_PERIOD)) ?? 0;
        if (!RATELIMIT_PERIODS.includes(period)) problems.push(`${bWhere}: @${RATELIMIT_ATTR_PERIOD} ${period}: the rate limiting binding accepts ${RATELIMIT_PERIODS.join(" or ")} seconds only`);
        bindings.push({ kind: BINDING_RATELIMIT, binding, from, namespaceId: text(b.attr(RATELIMIT_ATTR_NAMESPACE_ID)) ?? "", limit: int(b.attr(RATELIMIT_ATTR_LIMIT)) ?? 0, period });
        break;
      }
    }
  }
  // Every resource the app needs is bound here, or said to be carried another way.
  for (const r of needed) {
    if (isExternal(r)) {
      unexpressed.push({ fact: `${describeResource(r)}, managed outside Cloudflare`, how: "Not bound: the Worker reaches it through its settings." });
      continue;
    }
    const kind = bindingKindFor(r);
    if (kind === undefined) {
      unexpressed.push({ fact: describeResource(r), how: `Cloudflare has no binding for this kind of resource. Reach it through settings, or model it as a kind a Worker binds (${bindableKinds()}).` });
    } else if (!bound.has(r.name) || !bindings.some((b) => b.kind === kind && b.binding === bindingName(r.name))) {
      problems.push(`${where}: ${app.name} needs resource.${r.subType} "${r.name}" and environment ${env.name} has no cloudflare.${kind} "${r.name}" binding it; the Worker would fail when it reaches for it`);
    }
  }

  // One name per binding in the Worker's env: vars, secrets, bindings and the assets binding share it.
  const assetsBinding = text(node.attr(WORKER_ATTR_ASSETS_BINDING));
  const names = [...vars.keys(), ...common.secrets, ...bindings.map((b) => b.binding), ...(assetsBinding !== undefined ? [assetsBinding] : [])];
  for (const n of new Set(names.filter((n, i) => names.indexOf(n) !== i))) problems.push(`${where}: ${n} is bound twice in the Worker's env (a var, a secret, a binding and the assets binding share one namespace)`);

  // Assets: the directory is the app's build.static.
  const notFound = text(node.attr(WORKER_ATTR_NOT_FOUND));
  const workerFirstAll = node.attr(WORKER_ATTR_WORKER_FIRST) === true;
  const workerFirstPaths = refList(node, WORKER_ATTR_WORKER_FIRST_PATHS);
  if (workerFirstAll && workerFirstPaths.length > 0) problems.push(`${where}: @${WORKER_ATTR_WORKER_FIRST} and @${WORKER_ATTR_WORKER_FIRST_PATHS} both set; say every request, or which paths`);
  const build = common.build;
  let assets: CloudflareAssets | undefined;
  if (build?.kind === BUILD_SUBTYPE_STATIC && build.directory !== undefined) {
    const workerFirst = workerFirstAll ? true : workerFirstPaths.length > 0 ? workerFirstPaths : undefined;
    assets = {
      directory: build.directory,
      ...(assetsBinding !== undefined ? { binding: assetsBinding } : {}),
      ...(notFound !== undefined ? { notFound } : {}),
      ...(workerFirst !== undefined ? { workerFirst } : {}),
    };
  } else if (assetsBinding !== undefined || notFound !== undefined || workerFirstAll || workerFirstPaths.length > 0) {
    problems.push(`${where}: asset attributes are set and ${app.name} has no build.static, whose @directory holds the assets`);
  }
  const main = text(node.attr(WORKER_ATTR_MAIN));
  if (main === undefined && assets === undefined) problems.push(`${where}: a Worker needs @${WORKER_ATTR_MAIN} or static assets (a build.static on ${app.name})`);
  if (build !== undefined && build.kind !== BUILD_SUBTYPE_STATIC && build.command === undefined) {
    problems.push(`${where}: ${app.name} is built by build.${build.kind}, which a Worker cannot run; use build.command or build.static`);
  }

  // Crons: each @jobs entry resolves to a scheduled app.job.
  const crons: CloudflareCron[] = [];
  for (const ref of refList(node, WORKER_ATTR_JOBS)) {
    const job = resolveSystemRef(node, ref, WORKER_ATTR_JOBS, [`${TYPE_APP}.${APP_SUBTYPE_JOB}`]);
    const schedule = job === undefined ? undefined : text(job.attr(APP_ATTR_SCHEDULE));
    if (job === undefined || job.subType !== APP_SUBTYPE_JOB) problems.push(`${where}: @${WORKER_ATTR_JOBS} "${ref}" does not resolve to an app.job (write System.job)`);
    else if (schedule === undefined) problems.push(`${where}: @${WORKER_ATTR_JOBS} "${ref}" has no @${APP_ATTR_SCHEDULE}, so there is no cron to trigger it`);
    else crons.push({ schedule, from: `${appKeyOf(job)} @${APP_ATTR_SCHEDULE}` });
  }

  let extra: Record<string, unknown> | undefined;
  const extraText = text(node.attr(WORKER_ATTR_EXTRA));
  if (extraText !== undefined) {
    try {
      const parsed: unknown = JSON.parse(extraText);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      extra = parsed as Record<string, unknown>;
      const clash = Object.keys(extra).filter((k) => GENERATED_WRANGLER_KEYS.includes(k));
      if (clash.length > 0) problems.push(`${where}: @${WORKER_ATTR_EXTRA} sets ${clash.join(", ")}, which the generator writes from the model; declare those facts in the model`);
    } catch {
      problems.push(`${where}: @${WORKER_ATTR_EXTRA} is not a JSON object`);
    }
  }

  if (common.domains.length > 0) {
    unexpressed.push({ fact: `DNS for ${common.domains.map((d) => `\`${d}\``).join(", ")}`, how: "Each domain is a custom domain route: Cloudflare creates its DNS record and certificate on deploy. The domain's zone must be on the same Cloudflare account." });
  }

  const compatibilityDate = text(node.attr(WORKER_ATTR_COMPATIBILITY_DATE)) ?? "";
  const workersDev = node.attr(WORKER_ATTR_WORKERS_DEV);
  if (common.token === undefined) return undefined;
  return {
    ...common,
    token: common.token,
    kind: DEPLOYMENT_SUBTYPE_WORKER,
    script: text(node.attr(WORKER_ATTR_SCRIPT)) ?? app.name,
    ...(main !== undefined ? { main } : {}),
    compatibilityDate,
    compatibilityFlags: refList(node, WORKER_ATTR_COMPATIBILITY_FLAGS),
    ...(typeof workersDev === "boolean" ? { workersDev } : {}),
    ...(assets !== undefined ? { assets } : {}),
    crons,
    vars: [...vars.values()],
    bindings,
    ...(extra !== undefined ? { extra } : {}),
    unexpressed,
  };
}

function readPages(node: MetaData, ctx: Context, problems: string[]): PagesDeployment | undefined {
  const read = readCommon(node, ctx, problems);
  if (read === undefined) return undefined;
  const { app, where, settings, common } = read;
  const unexpressed = commonUnexpressed(node, app, settings, common.secrets, common.vault);
  const build = common.build;
  if (build?.kind !== BUILD_SUBTYPE_STATIC || build.directory === undefined) {
    problems.push(`${where}: a Pages site uploads a directory of files: ${app.name} needs a build.static with @directory`);
  }
  const plain = settings.filter((s) => !s.secret && s.phase !== PHASE_BUILD).map((s) => s.envName);
  // ADR-0039: resolving, so a value the abstract base declares counts.
  const values = node.children().filter((c) => c.type === TYPE_VALUE).map((v) => v.name);
  if (plain.length > 0 || values.length > 0) {
    unexpressed.push({
      fact: `Non-secret settings${plain.length > 0 ? ` ${plain.map((n) => `\`${n}\``).join(", ")}` : ""}${values.length > 0 ? ` (value nodes ${values.map((n) => `\`${n}\``).join(", ")})` : ""}`,
      how: "A Pages project keeps its environment variables in its own settings; `wrangler pages deploy` uploads files only. Set them in the project, or deploy the app as a Worker with assets.",
    });
  }
  if (common.domains.length > 0) {
    unexpressed.push({ fact: `Custom domains ${common.domains.map((d) => `\`${d}\``).join(", ")}`, how: "Attached to the Pages project once, in the project's settings; an upload does not change them. deploy/cloudflare/doctor.sh checks each answers." });
  }
  if (common.token === undefined) return undefined;
  return {
    ...common,
    token: common.token,
    kind: DEPLOYMENT_SUBTYPE_PAGES,
    project: text(node.attr(PAGES_ATTR_PROJECT)) ?? "",
    directory: build?.directory ?? "",
    unexpressed,
  };
}

/** The config pack's readers, their problems folded into this pack's list. */
function configRead<T>(read: () => T, problems: string[], fallback: T): T {
  try {
    return read();
  } catch (e) {
    if (!(e instanceof ConfigModelError)) throw e;
    problems.push(...e.problems);
    return fallback;
  }
}

/** The app a deployment names, as its node, or undefined. */
function appOf(d: MetaData): MetaData | undefined {
  const ref = refList(d, DEPLOYMENT_ATTR_APP)[0];
  return ref === undefined ? undefined : resolveSystemRef(d, ref, DEPLOYMENT_ATTR_APP, [TYPE_APP]);
}

/**
 * The one app whose Cloudflare deployments the generators write (`opts.app`, or the model's
 * only one), or undefined when the model deploys nothing to Cloudflare. `objects` are the
 * run's objects (the settings groups are among them); `inScope` is the run's scope over a
 * node's resolution key. Throws a {@link CloudflareModelError} listing every problem.
 */
export function readCloudflare(
  root: MetaRoot,
  objects: readonly MetaObject[],
  inScope: (key: string) => boolean = () => true,
  opts: ReadCloudflareOptions = {},
): CloudflareApp | undefined {
  const problems: string[] = [];
  const groups = configRead(() => readSettings(objects), problems, []);
  const vaults = configRead(() => readVaults(root, inScope), problems, []);
  // A settings or vault problem makes every deployment that reads them look wrong too: report it alone.
  if (problems.length > 0) throw new CloudflareModelError(problems);
  // ADR-0039: resolving, the deployments the model effectively holds. An abstract one is a base, never deployed.
  const all = root.children().filter((d) => isCloudflareDeployment(d) && !d.isAbstract);
  const ctx: Context = { all, groups, vaults };

  const inRun = all.filter((d) => inScope(d.resolutionKey()));
  const apps = [...new Set(inRun.map(appOf).filter((a): a is MetaData => a !== undefined))];
  if (apps.length === 0) return undefined;
  let app: MetaData | undefined;
  if (opts.app !== undefined) {
    app = apps.find((a) => a.name === opts.app || `${a.parent?.name}.${a.name}` === opts.app || appKeyOf(a).endsWith(` ${opts.app}`));
    if (app === undefined) throw new CloudflareModelError([`no Cloudflare deployment deploys app "${opts.app}" (the model deploys: ${apps.map(appKeyOf).join(", ")})`]);
  } else if (apps.length > 1) {
    throw new CloudflareModelError([`the model deploys ${apps.length} apps to Cloudflare (${apps.map(appKeyOf).join(", ")}); one wrangler.jsonc and one set of scripts are for one app, so pass { app } to the generators`]);
  } else {
    app = apps[0]!;
  }

  const nodes = inRun.filter((d) => appOf(d) === app);
  const kinds = new Set(nodes.map((d) => d.subType));
  if (kinds.size > 1) {
    throw new CloudflareModelError([`${appKeyOf(app)} is deployed both as a Worker and as a Pages site; deploy one app one way (a Worker with static assets replaces a Pages site)`]);
  }
  const kind = nodes[0]!.subType === DEPLOYMENT_SUBTYPE_PAGES ? DEPLOYMENT_SUBTYPE_PAGES : DEPLOYMENT_SUBTYPE_WORKER;
  const deployments = nodes
    .map((d) => (kind === DEPLOYMENT_SUBTYPE_PAGES ? readPages(d, ctx, problems) : readWorker(d, ctx, problems)))
    .filter((d): d is CloudflareDeployment => d !== undefined);

  const envs = deployments.map((d) => d.environment);
  let topLevel = opts.topLevel ?? (envs.length === 1 ? envs[0] : envs.includes(DEFAULT_TOP_LEVEL) ? DEFAULT_TOP_LEVEL : undefined);
  if (topLevel === undefined) {
    // Only when some deployment read clean: otherwise the problems above are the whole story.
    if (deployments.length > 0) problems.push(`${appKeyOf(app)} deploys to ${envs.join(", ")}, and none is named ${DEFAULT_TOP_LEVEL}: pass { topLevel } to the generators to say which environment \`wrangler deploy\` with no --env deploys`);
    topLevel = "";
  } else if (deployments.length > 0 && !envs.includes(topLevel)) {
    problems.push(`{ topLevel: "${topLevel}" } names an environment ${appKeyOf(app)} is not deployed to (${envs.join(", ")})`);
  }
  if (kind === DEPLOYMENT_SUBTYPE_WORKER && topLevel !== "") {
    // Two environments must not deploy over one Worker: the env-block names come from the top level's.
    const top = deployments.find((d) => d.environment === topLevel) as WorkerDeployment | undefined;
    const seen = new Map<string, string>();
    for (const d of deployments as WorkerDeployment[]) {
      const name = top === undefined || d === top ? d.script : workerName(d, top);
      const other = seen.get(name);
      if (other !== undefined) problems.push(`deployment.worker ${d.key}: deploys Worker "${name}", as ${other} does; give one a different @script`);
      else seen.set(name, d.key);
    }
  }
  if (problems.length > 0) throw new CloudflareModelError(problems);
  const ordered = [...deployments.filter((d) => d.environment === topLevel), ...deployments.filter((d) => d.environment !== topLevel)];
  return { name: app.name, appKey: appKeyOf(app), kind, deployments: ordered, topLevel };
}

/**
 * The Worker name an env block deploys: the deployment's own @script when it differs from the
 * top level's, else `<top-level name>-<environment>`, Wrangler's own default for an env block.
 */
export function workerName(d: WorkerDeployment, top: WorkerDeployment): string {
  return d.script !== top.script ? d.script : `${top.script}-${d.environment}`;
}
