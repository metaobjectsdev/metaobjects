// What the service layer covers (ADR-0067 §1, layer 4), for one model.
//
// Engine, not emit: `serviceFile()` and `serviceRoutesFile()` render these records, and an ejected
// copy of either keeps calling this walk, so which objects get a service operation, what the
// operations are named and where their files go stays packaged while the files' shape is the
// adopter's.
//
// Covered: every concrete `object.entity` whose primary source is a writable `source.rdb`, keyed
// by a single-field primary identity. It gets the five derived operations (list, get, create,
// update and delete), a command per transition that derives one (ADR-0066 §2, under
// `rules.lifecycle.commands`), and the package's declared operations that act on a covered entity
// or on none. Not covered yet: a write-through entity (reads through a replica view), a
// single-table (TPH) hierarchy, many-to-many traversal, projections and reports.

import {
  BINDING_ATTR_METHOD,
  BINDING_ATTR_PATH,
  IDENTITY_ATTR_FIELDS,
  OBJECT_SUBTYPE_ENTITY,
  OPERATION_ATTR_ERRORS,
  OPERATION_ATTR_INPUT_REF,
  OPERATION_ATTR_MANY,
  OPERATION_ATTR_OUTPUT_REF,
  OPERATION_ATTR_TRANSITIONS,
  OPERATION_SUBTYPE_COMMAND,
  TRANSITION_ATTR_CONDITION,
  TYPE_BINDING,
  TYPE_FIELD,
  claimedTransitions,
  commandPermission,
  derivedCommandsOf,
  effectivePackageOf,
  entityLineage,
  isMetaObject,
  lifecyclesOf,
  modelOperations,
  needsPermissionName,
  operationIsKeyed,
  operationPermission,
  operationTarget,
  refTarget,
  rulesSettingsOfModel,
  topLevelNodeOf,
  transitionFrom,
  transitionTo,
  type MetaData,
  type MetaObject,
  type RulesSettings,
} from "@metaobjectsdev/metadata";
import { restPath } from "./templates/entity-ui-descriptor.js";
import { packageToPath } from "./import-path.js";
import { posix } from "node:path";
import { contractSpecifier } from "./contract-walk.js";
import { HTTP_RUNTIME_MODULES, HTTP_RUNTIME_PACKAGE, type HttpRuntimeModule } from "./owned-runtime.js";
import type { ExtStyle, RenderContext } from "./render-context.js";
import type { GenContext } from "./generator.js";
import { effectivePackage } from "./docs-paths.js";
import { hasWritableRdbSource } from "./source-detect.js";
import { isAbstract } from "./instance-artifacts.js";
import { isWriteThrough } from "./projection/projection-detector.js";
import { declaresTphDiscriminator, isTphSubtype } from "./tph.js";
import { pkInfoOf } from "./pk-resolver.js";
import { listFnName, toCamelCase, toPascalCase } from "./naming.js";

/** The folder a package's service files go in, under the package's directory in either layout. */
export const SERVICE_DIR = "service";

/** The service module's index file: the operations interface and its factory. */
export const SERVICE_INDEX_FILE = "index.ts";

/** The five derived operations of an entity, in the order the files and the interface list them. */
export const DERIVED_OPERATIONS = ["list", "get", "create", "update", "delete"] as const;
export type DerivedOperation = (typeof DERIVED_OPERATIONS)[number];

/** One move of a lifecycle (ADR-0066 §2), as the guarded update makes it. */
export interface ServiceTransition {
  readonly name: string;
  /** The lifecycle's field. */
  readonly field: string;
  readonly from: readonly string[];
  readonly to: string;
  /** The `@condition` node (attr.expression), when the move has one. */
  readonly condition: unknown;
}

/** One lifecycle of an entity: its field and its initial state (the enum's `@default`). */
export interface ServiceLifecycle {
  readonly field: string;
  readonly initial: string | undefined;
}

/** The command a transition derives on an entity (ADR-0066 §2): it takes the key and makes the move. */
export interface ServiceTransitionCommand {
  /** The service function: `<transition><Entity>` (`submitPurchaseRequest`). */
  readonly fn: string;
  readonly transition: ServiceTransition;
  /** The permission it asks the policy about; undefined when the transition is `@public`. */
  readonly permission: string | undefined;
}

/** One entity's service operations. */
export interface ServiceEntity {
  readonly obj: MetaObject;
  /** The field the primary identity names: the key a get, update or delete takes. */
  readonly keyField: string;
  /** The function name of each derived operation (`listAuthors`, `getAuthor`, ...). */
  readonly operations: Readonly<Record<DerivedOperation, string>>;
  /** The entity's lifecycles: the generic write path may not move them (409 `state_managed`). */
  readonly lifecycles: readonly ServiceLifecycle[];
  /** The commands its transitions derive, in lifecycle order. */
  readonly commands: readonly ServiceTransitionCommand[];
}

/** A declared `operation.command` or `operation.query` (ADR-0066 §1). */
export interface ServiceOperation {
  /** The operation's name, which is its service function's. */
  readonly name: string;
  readonly kind: "command" | "query";
  /** The covered entity it acts on, when it has one. */
  readonly target: ServiceEntity | undefined;
  /** Whether it addresses one row of the target by key (ADR-0066 §3). */
  readonly keyed: boolean;
  /** The `@inputRef` value object. */
  readonly input: MetaObject | undefined;
  /** The input's field that borrows the target's key, when the operation is keyed by its input. */
  readonly inputKeyField: string | undefined;
  /** The `@outputRef` object. */
  readonly output: MetaObject | undefined;
  readonly many: boolean;
  /** The moves a command may make (`@transitions`), resolved on the target. */
  readonly transitions: readonly ServiceTransition[];
  /** The business errors a command's body may return (`@errors`). */
  readonly errors: readonly string[];
  /** The permission it asks the policy about; undefined when it is `@public`. */
  readonly permission: string | undefined;
  /** The REST method: `binding.rest @method`, else GET for a query and POST for a command. */
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The REST path in the Fastify form (`/purchase-requests/:id/decision`), before the API prefix. */
  readonly path: string;
}

/** One metadata package's service module. */
export interface ServicePackage {
  readonly package: string;
  readonly entities: readonly ServiceEntity[];
  /** The package's declared operations a service covers, in model order, once each. */
  readonly operations: readonly ServiceOperation[];
  /** Every permission a point of the package asks about, sorted, once each. */
  readonly permissions: readonly string[];
  /** The settings the model was loaded with (`rules.lifecycle.create` decides a create's states). */
  readonly settings: RulesSettings;
}

export interface ServiceWalkOpts {
  /** Narrow which objects are covered (the generator's `filter` and the run's selection). */
  matches?: (obj: MetaObject) => boolean;
}

/** Whether `obj` gets the derived service operations. */
export function hasServiceOperations(obj: MetaObject): boolean {
  if (obj.subType !== OBJECT_SUBTYPE_ENTITY || isAbstract(obj)) return false;
  if (!hasWritableRdbSource(obj) || isWriteThrough(obj)) return false;
  if (declaresTphDiscriminator(obj) || isTphSubtype(obj)) return false;
  return serviceKeyField(obj) !== undefined;
}

/** The single field a service operation addresses a row by, or undefined for a composite or absent key. */
export function serviceKeyField(obj: MetaObject): string | undefined {
  const pk = pkInfoOf(obj);
  if (pk === undefined) return undefined;
  const fields = obj.primaryIdentity()?.attr(IDENTITY_ATTR_FIELDS);
  if (Array.isArray(fields) && fields.length !== 1) return undefined;
  return pk.fieldName;
}

/** The derived operation names of `obj`. */
export function serviceOperationNames(obj: MetaObject): Readonly<Record<DerivedOperation, string>> {
  return {
    list: listFnName(obj),
    get: `get${obj.name}`,
    create: `create${obj.name}`,
    update: `update${obj.name}`,
    delete: `delete${obj.name}`,
  };
}

function transitionOf(t: MetaData, field: string): ServiceTransition {
  return { name: t.name, field, from: transitionFrom(t), to: transitionTo(t) ?? "", condition: t.attr(TRANSITION_ATTR_CONDITION) };
}

function stringsOf(node: MetaData, attr: string): string[] {
  const v = node.attr(attr);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : [];
}

/** A point that asks about a derived name is refused under `rules.permissions.names: require`. */
function requireDeclared(settings: RulesSettings, node: MetaData, what: string, derived: string | undefined): void {
  if (settings.permissionNames === "require" && needsPermissionName(node)) {
    throw new Error(
      `service: ${what} declares no @permission and is not @public, and rules.permissions.names is "require"; declare its permission (it would derive "${derived}")`,
    );
  }
}

function entityRules(obj: MetaObject, claimed: ReturnType<typeof claimedTransitions>, settings: RulesSettings) {
  const lifecycles = lifecyclesOf(obj);
  const fieldOf = new Map<MetaData, string>();
  for (const l of lifecycles) for (const t of l.transitions) fieldOf.set(t, l.field.name);
  const commands = derivedCommandsOf(obj, claimed, settings).map((t) => {
    requireDeclared(settings, t, `transition ${obj.name}.${fieldOf.get(t)}.${t.name}`, commandPermission(obj, t));
    return {
      fn: `${toCamelCase(t.name)}${obj.name}`,
      transition: transitionOf(t, fieldOf.get(t) ?? ""),
      permission: commandPermission(obj, t),
    };
  });
  return { lifecycles: lifecycles.map((l) => ({ field: l.field.name, initial: l.initial })), commands };
}

/** The input field that extends one of `target`'s key fields (the borrowed key, ADR-0066 §3). */
function borrowedKeyField(input: MetaObject, target: MetaObject, keyField: string): string | undefined {
  const lineage = entityLineage(target);
  for (const f of input.children()) {
    if (f.type !== TYPE_FIELD) continue;
    const sup = f.superResolved;
    if (sup?.name === keyField && sup.parent !== undefined && lineage.includes(sup.parent)) return f.name;
  }
  return undefined;
}

function asObject(node: MetaData | undefined): MetaObject | undefined {
  return node !== undefined && isMetaObject(node) ? node : undefined;
}

function operationOf(op: MetaData, target: ServiceEntity | undefined, settings: RulesSettings): ServiceOperation {
  const kind = op.subType === OPERATION_SUBTYPE_COMMAND ? "command" : "query";
  requireDeclared(settings, op, `operation ${op.name}`, operationPermission(op));
  const input = asObject(refTarget(op, OPERATION_ATTR_INPUT_REF));
  const keyed = target !== undefined && operationIsKeyed(op);
  const lifecycles = target === undefined ? [] : lifecyclesOf(target.obj);
  const names = new Set(kind === "command" ? stringsOf(op, OPERATION_ATTR_TRANSITIONS) : []);
  const transitions = lifecycles.flatMap((l) => l.transitions.filter((t) => names.has(t.name)).map((t) => transitionOf(t, l.field.name)));
  const binding = op.children().find((c) => c.type === TYPE_BINDING);
  const declaredMethod = binding?.attr(BINDING_ATTR_METHOD);
  const declaredPath = binding?.attr(BINDING_ATTR_PATH);
  const method = (typeof declaredMethod === "string" ? declaredMethod : kind === "query" ? "GET" : "POST") as ServiceOperation["method"];
  const base = target === undefined ? "" : restPath(target.obj);
  const path = typeof declaredPath === "string"
    ? declaredPath.replace(/\{([^}]*)\}/g, ":$1")
    : keyed ? `${base}/:${target!.keyField}/${op.name}` : `${base}/${op.name}`;
  return {
    name: op.name,
    kind,
    target,
    keyed,
    input,
    inputKeyField: keyed && input !== undefined ? borrowedKeyField(input, target!.obj, target!.keyField) : undefined,
    output: asObject(refTarget(op, OPERATION_ATTR_OUTPUT_REF)),
    many: op.attr(OPERATION_ATTR_MANY) === true,
    transitions,
    errors: kind === "command" ? stringsOf(op, OPERATION_ATTR_ERRORS) : [],
    permission: operationPermission(op),
    method,
    path,
  };
}

/**
 * The service modules of `root`, one per package that has a covered entity or a declared
 * operation the service covers, sorted by package.
 */
export function serviceModelOf(root: MetaData, opts: ServiceWalkOpts = {}): ServicePackage[] {
  const matches = opts.matches ?? (() => true);
  const settings = rulesSettingsOfModel(root);
  const claimed = claimedTransitions(root);
  const packages = new Map<string, { entities: ServiceEntity[]; operations: ServiceOperation[] }>();
  const bucket = (pkg: string) => {
    let b = packages.get(pkg);
    if (b === undefined) { b = { entities: [], operations: [] }; packages.set(pkg, b); }
    return b;
  };
  const covered = new Map<MetaData, ServiceEntity>();
  for (const obj of root.children().filter(isMetaObject)) {
    if (!hasServiceOperations(obj) || !matches(obj)) continue;
    const e: ServiceEntity = { obj, keyField: serviceKeyField(obj)!, operations: serviceOperationNames(obj), ...entityRules(obj, claimed, settings) };
    covered.set(obj, e);
    bucket(effectivePackage(obj) ?? "").entities.push(e);
  }
  // One operation declared identically by two APIs (a versioned API) is one operation (O6). An
  // operation whose target the service does not cover (a single-table hierarchy, say) is left to
  // later service work, as its entity is.
  const seen = new Set<string>();
  for (const op of modelOperations(root)) {
    const targetNode = operationTarget(op);
    const target = targetNode === undefined ? undefined : covered.get(targetNode);
    if (targetNode !== undefined && target === undefined) continue;
    const pkg = effectivePackageOf(topLevelNodeOf(op));
    const id = `${pkg}\u0000${op.name.toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    bucket(pkg).operations.push(operationOf(op, target, settings));
  }
  return [...packages.keys()].sort().map((pkg) => {
    const { entities, operations } = packages.get(pkg)!;
    const permissions = new Set<string>();
    for (const e of entities) for (const c of e.commands) if (c.permission !== undefined) permissions.add(c.permission);
    for (const o of operations) if (o.permission !== undefined) permissions.add(o.permission);
    return { package: pkg, entities, operations, permissions: [...permissions].sort(), settings };
  });
}

/** Where a file of package `pkg`'s service module goes, relative to the target's outDir. */
export function servicePath(pkg: string, file: string): string {
  const dir = packageToPath(pkg);
  return dir === "" ? `${SERVICE_DIR}/${file}` : `${dir}/${SERVICE_DIR}/${file}`;
}

/** The name of package `pkg`'s service type: its last segment, PascalCase, plus `Service`
 *  (`acme::purchasing` → `PurchasingService`, `acme::purchase_orders` → `PurchaseOrdersService`);
 *  the root package's is `ModelService`. */
export function serviceTypeName(pkg: string): string {
  const segments = pkg.split("::").filter((s) => s !== "");
  const last = segments[segments.length - 1];
  return `${last === undefined ? "Model" : toPascalCase(toCamelCase(last))}Service`;
}

/** The factory that builds package `pkg`'s service: `create<Type>`. */
export function serviceFactoryName(pkg: string): string {
  return `create${serviceTypeName(pkg)}`;
}

/** The Fastify plugin that mounts package `pkg`'s service routes: `<type, first letter lowered>Routes`. */
export function serviceRoutesName(pkg: string): string {
  const type = serviceTypeName(pkg);
  return `${type.charAt(0).toLowerCase()}${type.slice(1)}Routes`;
}

/** The folder a package's thin transport goes in (ADR-0067 layer 5): its own, beside the service
 *  module's, so each generator owns the paths it writes. */
export const TRANSPORT_DIR = "transport";

/** The Fastify transport's file in {@link TRANSPORT_DIR}. */
export const FASTIFY_TRANSPORT_FILE = "fastify.ts";

/** Where package `pkg`'s Fastify transport goes, relative to the target's outDir. */
export function fastifyTransportPath(pkg: string): string {
  const dir = packageToPath(pkg);
  return dir === "" ? `${TRANSPORT_DIR}/${FASTIFY_TRANSPORT_FILE}` : `${dir}/${TRANSPORT_DIR}/${FASTIFY_TRANSPORT_FILE}`;
}

/**
 * The import specifier of a runtime module, as seen from the generated file at `fromFile`
 * (relative to the target's outDir). The service and transport files sit one folder below their
 * package's directory in either layout, so a relative `httpRuntimeImport` (an owned copy, ADR-0034
 * Amendment 3) is resolved from the file itself rather than from the package directory.
 */
export function runtimeSpecifierFrom(
  fromFile: string,
  module: HttpRuntimeModule,
  ctx: { httpRuntimeImport?: string | undefined; extStyle: ExtStyle },
): string {
  const entry = HTTP_RUNTIME_MODULES[module];
  const base = ctx.httpRuntimeImport?.replace(/\/$/, "");
  if (base === undefined || base === HTTP_RUNTIME_PACKAGE) return `${HTTP_RUNTIME_PACKAGE}/${entry.subpath}`;
  if (base.startsWith("./") || base.startsWith("../")) {
    return contractSpecifier(fromFile, posix.normalize(`${base}/${entry.file}.ts`), ctx.extStyle);
  }
  return ctx.extStyle === "js" ? `${base}/${entry.file}.js` : `${base}/${entry.file}`;
}

/**
 * The render context a service-layer generator runs with. Refused when the run supplies none, or
 * when the generator writes to another target than the entity module: the service and transport
 * files import the entity module and the contract types by a relative path.
 */
export function serviceRenderContext(ctx: GenContext, generator: string, runtimeImport: string | undefined): RenderContext {
  const rc = ctx.renderContext;
  if (!rc) throw new Error(`${generator}: renderContext is required (provided by runGen)`);
  if (rc.selfTarget.name !== rc.entityModuleTarget.name) {
    throw new Error(`${generator}: write it to the entity module's target ("${rc.entityModuleTarget.name}"), not "${rc.selfTarget.name}"`);
  }
  return runtimeImport === undefined ? rc : { ...rc, httpRuntimeImport: runtimeImport };
}
