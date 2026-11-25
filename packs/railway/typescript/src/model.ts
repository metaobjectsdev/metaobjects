/**
 * What the model says about Railway, read once for every generator in the pack.
 *
 * A deployment.railway names its app and environment; the app holds the facts true
 * everywhere (its build, its processes, the settings groups it reads); the deployment adds
 * what differs here. This module joins them into one plain record per deployment and groups
 * the deployments by Railway project, which is what one `.railway/railway.ts` declares.
 *
 * Accessors are the resolving ones (ADR-0039), so an estate overlay or an `extends` reads
 * like a fact declared in place. Problems a loader cannot see (a value for a setting nobody
 * declared, a reference Railway cannot supply, a secret with no vault) are collected and
 * thrown together, each naming its node.
 */
import type { MetaData, MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import {
  readSettings,
  readVaults,
  ConfigModelError,
  VAULT_SUBTYPE_INFISICAL,
  type Setting,
  type SettingsGroup,
  type Vault,
  type VaultScope,
} from "@metaobjectsdev/pack-config";
import {
  BUILD_ATTR_COMMAND,
  BUILD_ATTR_CONTEXT,
  BUILD_ATTR_DIRECTORY,
  BUILD_ATTR_PATH,
  BUILD_ATTR_WATCH_EXCLUDE,
  BUILD_ATTR_WATCH_INCLUDE,
  BUILD_SUBTYPE_STATIC,
  DEPLOYMENT_ATTR_APP,
  DEPLOYMENT_ATTR_BRANCH,
  DEPLOYMENT_ATTR_DOMAINS,
  DEPLOYMENT_ATTR_ENVIRONMENT,
  DEPLOYMENT_ATTR_REGION,
  DEPLOYMENT_ATTR_REPLICAS,
  DEPLOYMENT_ATTR_SECRETS,
  RUNTIME_ATTR_COMMAND,
  RUNTIME_ATTR_DRAIN_SECONDS,
  RUNTIME_ATTR_HEALTH_PATH,
  RUNTIME_ATTR_HEALTH_TIMEOUT_SECONDS,
  RUNTIME_ATTR_PORT,
  RUNTIME_ATTR_RESTART,
  TYPE_BUILD,
  TYPE_DEPLOYMENT,
  TYPE_ENVIRONMENT,
  TYPE_RUNTIME,
  TYPE_VALUE,
  VALUE_ATTR_LITERAL,
  VALUE_ATTR_OUTPUT,
  VALUE_ATTR_PATH,
  VALUE_ATTR_PRODUCED_BY,
  VALUE_ATTR_SETTING,
  VALUE_SUBTYPE_LITERAL,
} from "@metaobjectsdev/pack-delivery";
import {
  APP_ATTR_NEEDS,
  APP_ATTR_SCHEDULE,
  APP_ATTR_SETTINGS,
  RESOURCE_ATTR_ENGINE,
  RESOURCE_ATTR_MANAGED_BY,
  RESOURCE_ATTR_VERSION,
  TYPE_APP,
  TYPE_RESOURCE,
  refList,
  resolveSystemRef,
} from "@metaobjectsdev/pack-systems";
import {
  DATABASE_OUTPUTS,
  DEPLOYMENT_SUBTYPE_RAILWAY,
  PARTIAL_PATTERN,
  RAILWAY_ATTR_CHECK_SUITES,
  RAILWAY_ATTR_IMAGE,
  RAILWAY_ATTR_PROJECT,
  RAILWAY_ATTR_REPO,
  RAILWAY_ATTR_SERVICE,
  RAILWAY_PRIVATE_DOMAIN,
  RAILWAY_PUBLIC_DOMAIN,
} from "./constants.js";

/** Thrown with every problem found, one per line, each naming its node. */
export class RailwayModelError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`railway pack: ${problems.length} problem(s) in the model:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "RailwayModelError";
  }
}

export interface RailwayBuild {
  /** The build subtype: dockerfile, command or static. */
  readonly kind: string;
  readonly watchInclude: readonly string[];
  readonly watchExclude: readonly string[];
  readonly path?: string;
  readonly context?: string;
  readonly command?: string;
  readonly directory?: string;
}

export interface RailwayProcess {
  readonly name: string;
  readonly command?: string;
  readonly port?: number;
  readonly healthPath?: string;
  readonly healthTimeoutSeconds?: number;
  readonly drainSeconds?: number;
  /** The model's restart value: always, onFailure or never. */
  readonly restart?: string;
}

/** One variable a managed file declares on a service. */
export interface RailwayVariable {
  readonly name: string;
  /** `literal`: a fixed string (a value.literal, a value.ref's reference template, a default). `preserve`: keep Railway's value. */
  readonly kind: "literal" | "preserve";
  readonly value?: string;
  /** Where it comes from, for the comment beside it. */
  readonly from: string;
}

/** A resource an app needs that Railway runs beside it and the file does not declare. */
export interface RailwayResource {
  readonly name: string;
  readonly kind: string;
  readonly engine?: string;
  readonly version?: string;
}

export interface RailwayDeployment {
  readonly key: string;
  readonly name: string;
  readonly environment: string;
  readonly project: string;
  readonly service: string;
  readonly appKey: string;
  /** The app subtype: service, client or job. */
  readonly appKind: string;
  readonly schedule?: string;
  readonly repo?: string;
  readonly image?: string;
  readonly branch?: string;
  readonly checkSuites?: boolean;
  readonly domains: readonly string[];
  readonly replicas?: number;
  readonly region?: string;
  readonly build?: RailwayBuild;
  readonly processes: readonly RailwayProcess[];
  /** Whether the deployment declares value.* nodes (the file then manages variables). */
  readonly hasValues: boolean;
  /** The variables a managed file declares, in name order. Empty for an unmanaged file. */
  readonly variables: readonly RailwayVariable[];
  /** Every setting of the settings groups the app reads. */
  readonly settings: readonly Setting[];
  /** Where the secret settings are read from at deploy. Absent when the app reads none. */
  readonly vault?: { readonly key: string; readonly scope: VaultScope };
  readonly resources: readonly RailwayResource[];
}

export interface RailwayProject {
  /** The Railway project's name. */
  readonly name: string;
  /** The named partial the file exports. */
  readonly partial: string;
  /** Whether the file manages variables (some deployment declares value.* nodes). */
  readonly manageVariables: boolean;
  /** The deployments, in model order. */
  readonly deployments: readonly RailwayDeployment[];
  /** The environments, in first-declared order. */
  readonly environments: readonly string[];
}

export interface ReadRailwayOptions {
  /** The Railway project to read, when the model deploys to more than one. */
  readonly project?: string;
  /** The named partial to export. Absent: the service's name when there is one, else the project's. */
  readonly partial?: string;
}

function text(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function int(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

function strings(node: MetaData, attr: string): string[] {
  return refList(node, attr);
}

export function isRailwayDeployment(node: MetaData): boolean {
  return node.type === TYPE_DEPLOYMENT && node.subType === DEPLOYMENT_SUBTYPE_RAILWAY;
}

function readBuild(app: MetaData): RailwayBuild | undefined {
  // ADR-0039: resolving, so a build an app inherits through `extends` counts.
  const b = app.children().find((c) => c.type === TYPE_BUILD);
  if (b === undefined) return undefined;
  const path = text(b.attr(BUILD_ATTR_PATH));
  const context = text(b.attr(BUILD_ATTR_CONTEXT));
  const command = text(b.attr(BUILD_ATTR_COMMAND));
  const directory = text(b.attr(BUILD_ATTR_DIRECTORY));
  return {
    kind: b.subType,
    watchInclude: strings(b, BUILD_ATTR_WATCH_INCLUDE),
    watchExclude: strings(b, BUILD_ATTR_WATCH_EXCLUDE),
    ...(path !== undefined ? { path } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(directory !== undefined ? { directory } : {}),
  };
}

function readProcesses(app: MetaData): RailwayProcess[] {
  // ADR-0039: resolving, as for the build.
  return app
    .children()
    .filter((c) => c.type === TYPE_RUNTIME)
    .map((p) => {
      const command = text(p.attr(RUNTIME_ATTR_COMMAND));
      const port = int(p.attr(RUNTIME_ATTR_PORT));
      const healthPath = text(p.attr(RUNTIME_ATTR_HEALTH_PATH));
      const healthTimeoutSeconds = int(p.attr(RUNTIME_ATTR_HEALTH_TIMEOUT_SECONDS));
      const drainSeconds = int(p.attr(RUNTIME_ATTR_DRAIN_SECONDS));
      const restart = text(p.attr(RUNTIME_ATTR_RESTART));
      return {
        name: p.name,
        ...(command !== undefined ? { command } : {}),
        ...(port !== undefined ? { port } : {}),
        ...(healthPath !== undefined ? { healthPath } : {}),
        ...(healthTimeoutSeconds !== undefined ? { healthTimeoutSeconds } : {}),
        ...(drainSeconds !== undefined ? { drainSeconds } : {}),
        ...(restart !== undefined ? { restart } : {}),
      };
    });
}

/** The settings groups `names` (each a group's name or resolution key) name, reporting each that matches none or several. */
function groupsNamed(names: readonly string[], groups: readonly SettingsGroup[], where: string, problems: string[]): SettingsGroup[] {
  const out: SettingsGroup[] = [];
  for (const n of names) {
    const hits = groups.filter((g) => g.key === n || g.name === n);
    if (hits.length === 1) out.push(hits[0]!);
    else if (hits.length === 0) {
      problems.push(`${where}: @${APP_ATTR_SETTINGS} names "${n}", which is no object.settings in the model; declare it (config pack) so its secrets can be synced, or remove it`);
    } else {
      problems.push(`${where}: @${APP_ATTR_SETTINGS} "${n}" matches ${hits.map((g) => g.key).join(" and ")}; name it by its package`);
    }
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

interface Context {
  readonly root: MetaRoot;
  readonly all: readonly MetaData[];
  readonly groups: readonly SettingsGroup[];
  readonly vaults: readonly Vault[];
}

/** The service name the deployment of `app` in `env` runs as, or undefined when Railway runs it nowhere there. */
function serviceOf(app: MetaData, env: MetaData, all: readonly MetaData[]): string | undefined {
  for (const d of all) {
    const a = refList(d, DEPLOYMENT_ATTR_APP)[0];
    const e = refList(d, DEPLOYMENT_ATTR_ENVIRONMENT)[0];
    if (a === undefined || e === undefined) continue;
    if (resolveSystemRef(d, a, DEPLOYMENT_ATTR_APP, [TYPE_APP]) !== app) continue;
    if (resolveSystemRef(d, e, DEPLOYMENT_ATTR_ENVIRONMENT, [TYPE_ENVIRONMENT]) !== env) continue;
    return text(d.attr(RAILWAY_ATTR_SERVICE)) ?? app.name;
  }
  return undefined;
}

const URL_OUTPUTS: readonly string[] = ["url", "privateUrl", "publicUrl"];

/** A value.ref as the reference template Railway resolves at deploy, its `@path` appended (`${{db.DATABASE_URL}}`), or a problem. */
function referenceTemplate(value: MetaData, env: MetaData, ctx: Context, where: string, problems: string[]): string | undefined {
  const path = text(value.attr(VALUE_ATTR_PATH));
  const output = text(value.attr(VALUE_ATTR_OUTPUT)) ?? "";
  if (path !== undefined && !URL_OUTPUTS.includes(output)) {
    problems.push(`${where}: @${VALUE_ATTR_PATH} is appended to a URL, and @${VALUE_ATTR_OUTPUT} ${output} is not one (${URL_OUTPUTS.join(", ")})`);
    return undefined;
  }
  const base = outputTemplate(value, env, ctx, where, problems);
  return base === undefined ? undefined : `${base}${path ?? ""}`;
}

function outputTemplate(value: MetaData, env: MetaData, ctx: Context, where: string, problems: string[]): string | undefined {
  const producedBy = text(value.attr(VALUE_ATTR_PRODUCED_BY)) ?? "";
  const output = text(value.attr(VALUE_ATTR_OUTPUT)) ?? "";
  const target = resolveSystemRef(value, producedBy, VALUE_ATTR_PRODUCED_BY, [TYPE_RESOURCE, TYPE_APP]);
  if (target === undefined) return undefined; // the delivery pack reports it at load
  if (target.type === TYPE_RESOURCE) {
    if (text(target.attr(RESOURCE_ATTR_MANAGED_BY)) === "external") {
      problems.push(`${where}: @${VALUE_ATTR_PRODUCED_BY} "${producedBy}" is managed outside Railway, which cannot supply its ${output}; give the setting its value from the vault (@secret) or a value.literal`);
      return undefined;
    }
    const engine = text(target.attr(RESOURCE_ATTR_ENGINE)) ?? "";
    const outputs = DATABASE_OUTPUTS[engine];
    const variable = outputs?.[output];
    if (variable === undefined) {
      problems.push(
        outputs === undefined
          ? `${where}: ${target.type}.${target.subType} "${target.name}" has @engine "${engine}"; Railway's database templates are ${Object.keys(DATABASE_OUTPUTS).join(", ")}`
          : `${where}: a Railway ${engine} supplies ${Object.keys(outputs).join(", ")}, not ${output}`,
      );
      return undefined;
    }
    return `\${{${target.name}.${variable}}}`;
  }
  const service = serviceOf(target, env, ctx.all);
  if (service === undefined) {
    problems.push(`${where}: app "${target.name}" has no deployment.railway in environment ${env.name}, so Railway has no address for it there`);
    return undefined;
  }
  const port = readProcesses(target).find((p) => p.port !== undefined)?.port;
  switch (output) {
    case "host":
      return `\${{${service}.${RAILWAY_PRIVATE_DOMAIN}}}`;
    case "publicUrl":
      return `https://\${{${service}.${RAILWAY_PUBLIC_DOMAIN}}}`;
    case "port":
    case "privateUrl":
      if (port === undefined) {
        problems.push(`${where}: app "${target.name}" declares no runtime.process @port, so its ${output} is unknown`);
        return undefined;
      }
      return output === "port" ? String(port) : `http://\${{${service}.${RAILWAY_PRIVATE_DOMAIN}}}:${port}`;
    default:
      problems.push(`${where}: an app supplies host, port, privateUrl or publicUrl, not ${output}`);
      return undefined;
  }
}

function readDeployment(node: MetaData, ctx: Context, problems: string[]): RailwayDeployment | undefined {
  const where = `deployment.railway ${node.resolutionKey()}`;
  const appRef = refList(node, DEPLOYMENT_ATTR_APP)[0];
  const envRef = refList(node, DEPLOYMENT_ATTR_ENVIRONMENT)[0];
  const app = appRef === undefined ? undefined : resolveSystemRef(node, appRef, DEPLOYMENT_ATTR_APP, [TYPE_APP]);
  const env = envRef === undefined ? undefined : resolveSystemRef(node, envRef, DEPLOYMENT_ATTR_ENVIRONMENT, [TYPE_ENVIRONMENT]);
  if (app === undefined || env === undefined) return undefined; // the delivery pack reports it at load

  const repo = text(node.attr(RAILWAY_ATTR_REPO));
  const image = text(node.attr(RAILWAY_ATTR_IMAGE));
  if (repo === undefined && image === undefined) {
    problems.push(`${where}: declare @${RAILWAY_ATTR_REPO} or @${RAILWAY_ATTR_IMAGE}; a Railway plan of a service with no source disconnects it`);
  } else if (repo !== undefined && image !== undefined) {
    problems.push(`${where}: declares both @${RAILWAY_ATTR_REPO} and @${RAILWAY_ATTR_IMAGE}; a Railway service has one source`);
  }

  const groups = groupsNamed(refList(app, APP_ATTR_SETTINGS), ctx.groups, `${app.type}.${app.subType} ${app.name}`, problems);
  const settings = groups.flatMap((g) => g.settings);

  // ADR-0039: resolving, so a value an estate overlay adds counts.
  const valueNodes = node.children().filter((c) => c.type === TYPE_VALUE);
  const variables = new Map<string, RailwayVariable>();
  for (const v of valueNodes) {
    const vWhere = `${where} value.${v.subType} ${v.name}`;
    const settingRef = text(v.attr(VALUE_ATTR_SETTING)) ?? "";
    const setting = settingNamed(settingRef, ctx.groups);
    if (setting === undefined) {
      problems.push(`${vWhere}: @${VALUE_ATTR_SETTING} "${settingRef}" names no setting (Group.field) of an object.settings in the model`);
      continue;
    }
    if (!settings.includes(setting)) {
      problems.push(`${vWhere}: ${settingRef} is not a setting of the groups ${app.name} reads (@${APP_ATTR_SETTINGS})`);
    }
    if (setting.secret) {
      problems.push(`${vWhere}: ${settingRef} is @secret; its value comes from the vault, never from a value node`);
      continue;
    }
    const value =
      v.subType === VALUE_SUBTYPE_LITERAL ? text(v.attr(VALUE_ATTR_LITERAL)) ?? "" : referenceTemplate(v, env, ctx, vWhere, problems);
    if (value !== undefined) variables.set(setting.envName, { name: setting.envName, kind: "literal", value, from: `value.${v.subType} ${v.name}` });
  }
  if (valueNodes.length > 0) {
    for (const s of settings) {
      if (variables.has(s.envName)) continue;
      if (s.secret) variables.set(s.envName, { name: s.envName, kind: "preserve", from: `${s.setting}, secret: copied from the vault by the sync script` });
      else if (s.default !== undefined) variables.set(s.envName, { name: s.envName, kind: "literal", value: s.default, from: `${s.setting} default` });
      else variables.set(s.envName, { name: s.envName, kind: "preserve", from: `${s.setting}, no value in the model: kept as set on Railway` });
    }
  }

  let vault: RailwayDeployment["vault"];
  const secrets = settings.filter((s) => s.secret);
  const vaultRef = text(node.attr(DEPLOYMENT_ATTR_SECRETS));
  if (vaultRef !== undefined) {
    const v = ctx.vaults.find((x) => x.name === vaultRef || x.key === vaultRef);
    const scope = v?.scopes.find((s) => s.name === env.name);
    if (v === undefined) problems.push(`${where}: @${DEPLOYMENT_ATTR_SECRETS} "${vaultRef}" names no vault.* in the model`);
    else if (v.product !== VAULT_SUBTYPE_INFISICAL) problems.push(`${where}: vault ${v.key} is vault.${v.product}; the sync script reads vault.${VAULT_SUBTYPE_INFISICAL} through keys-axi`);
    else if (scope === undefined) problems.push(`${where}: vault ${v.key} has no scope.env named "${env.name}", so the environment's secrets have no place`);
    else vault = { key: v.key, scope };
  } else if (secrets.length > 0) {
    problems.push(`${where}: ${app.name} reads ${secrets.length} secret setting(s) (${secrets.map((s) => s.envName).join(", ")}) and the deployment names no vault; set @${DEPLOYMENT_ATTR_SECRETS}`);
  }

  const resources: RailwayResource[] = [];
  for (const ref of refList(app, APP_ATTR_NEEDS)) {
    const r = resolveSystemRef(app, ref, APP_ATTR_NEEDS, [TYPE_RESOURCE]);
    if (r === undefined || text(r.attr(RESOURCE_ATTR_MANAGED_BY)) === "external") continue;
    const engine = text(r.attr(RESOURCE_ATTR_ENGINE));
    const version = text(r.attr(RESOURCE_ATTR_VERSION));
    resources.push({ name: r.name, kind: `${r.type}.${r.subType}`, ...(engine !== undefined ? { engine } : {}), ...(version !== undefined ? { version } : {}) });
  }

  const build = readBuild(app);
  const schedule = text(app.attr(APP_ATTR_SCHEDULE));
  const branch = text(node.attr(DEPLOYMENT_ATTR_BRANCH));
  const checkSuites = node.attr(RAILWAY_ATTR_CHECK_SUITES);
  const replicas = int(node.attr(DEPLOYMENT_ATTR_REPLICAS));
  const region = text(node.attr(DEPLOYMENT_ATTR_REGION));
  return {
    key: node.resolutionKey(),
    name: node.name,
    environment: env.name,
    project: text(node.attr(RAILWAY_ATTR_PROJECT)) ?? "",
    service: text(node.attr(RAILWAY_ATTR_SERVICE)) ?? app.name,
    appKey: `${app.type}.${app.subType} ${app.name}`,
    appKind: app.subType,
    ...(schedule !== undefined ? { schedule } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(image !== undefined ? { image } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(typeof checkSuites === "boolean" ? { checkSuites } : {}),
    domains: strings(node, DEPLOYMENT_ATTR_DOMAINS),
    ...(replicas !== undefined ? { replicas } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(build !== undefined ? { build } : {}),
    processes: readProcesses(app),
    hasValues: valueNodes.length > 0,
    variables: [...variables.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    settings,
    ...(vault !== undefined ? { vault } : {}),
    resources,
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

/**
 * Every Railway project the model deploys to, with its deployments. `objects` are the run's
 * objects (the settings groups are among them); `inScope` is the run's scope over a node's
 * resolution key. Throws a {@link RailwayModelError} listing every problem.
 */
export function readRailway(
  root: MetaRoot,
  objects: readonly MetaObject[],
  inScope: (key: string) => boolean = () => true,
  opts: ReadRailwayOptions = {},
): RailwayProject[] {
  const problems: string[] = [];
  const groups = configRead(() => readSettings(objects), problems, []);
  const vaults = configRead(() => readVaults(root, inScope), problems, []);
  // ADR-0039: resolving, the deployments the model effectively holds.
  const all = root.children().filter(isRailwayDeployment);
  const ctx: Context = { root, all, groups, vaults };
  const deployments = all
    .filter((d) => inScope(d.resolutionKey()))
    .map((d) => readDeployment(d, ctx, problems))
    .filter((d): d is RailwayDeployment => d !== undefined)
    .filter((d) => opts.project === undefined || d.project === opts.project);

  const byProject = new Map<string, RailwayDeployment[]>();
  for (const d of deployments) byProject.set(d.project, [...(byProject.get(d.project) ?? []), d]);
  if (opts.project !== undefined && byProject.size === 0 && all.length > 0) {
    problems.push(`no deployment.railway has @${RAILWAY_ATTR_PROJECT} "${opts.project}" (the model deploys to: ${[...new Set(all.map((d) => text(d.attr(RAILWAY_ATTR_PROJECT))))].join(", ")})`);
  }

  const projects: RailwayProject[] = [];
  for (const [name, ds] of byProject) {
    const services = [...new Set(ds.map((d) => d.service))];
    const partial = opts.partial ?? (services.length === 1 ? services[0]! : name);
    if (!PARTIAL_PATTERN.test(partial)) {
      problems.push(`Railway project ${name}: the partial name "${partial}" is not 1 to 64 of a-z A-Z 0-9 . _ -; pass { partial } to the generator`);
    }
    const manageVariables = ds.some((d) => d.hasValues);
    if (manageVariables) {
      for (const d of ds.filter((x) => x.settings.length === 0)) {
        problems.push(
          `deployment.railway ${d.key}: another deployment in Railway project ${name} declares value.* nodes, so the file manages variables, and ${d.appKey} reads no settings group: an apply would delete every variable of service ${d.service}. Declare its settings (@${APP_ATTR_SETTINGS})`,
        );
      }
    }
    projects.push({ name, partial, manageVariables, deployments: ds, environments: [...new Set(ds.map((d) => d.environment))] });
  }
  if (problems.length > 0) throw new RailwayModelError(problems);
  return projects;
}

/** The one project a generator writes for: `opts.project`, or the model's only one. Undefined when the model deploys nothing to Railway. */
export function pickProject(projects: readonly RailwayProject[]): RailwayProject | undefined {
  if (projects.length > 1) {
    throw new RailwayModelError([`the model deploys to ${projects.length} Railway projects (${projects.map((p) => p.name).join(", ")}); one .railway/railway.ts declares one, so pass { project } to the generator`]);
  }
  return projects[0];
}

/** Whether a build or process fact belongs on the file (used by the unexpressed list too). */
export function isStatic(build: RailwayBuild | undefined): boolean {
  return build?.kind === BUILD_SUBTYPE_STATIC;
}
