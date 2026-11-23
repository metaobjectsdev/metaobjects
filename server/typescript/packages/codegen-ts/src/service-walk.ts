// What the service layer covers (ADR-0067 §1, layer 4), for one model.
//
// Engine, not emit: `serviceFile()` and `serviceRoutesFile()` render these records, and an ejected
// copy of either keeps calling this walk, so which objects get a service operation, what the
// operations are named and where their files go stays packaged while the files' shape is the
// adopter's.
//
// Covered: every object the flat routes serve, keyed by a single-field primary identity where it
// has a key. A concrete `object.entity` whose primary source is a writable `source.rdb` gets the
// five derived operations (list, get, create, update and delete); a write-through entity reads
// through its replica view and writes its table. A single-table (TPH) hierarchy's discriminator
// base gets a polymorphic list and get, and each concrete subtype the five operations, scoped to its
// discriminator value. A projection gets a list, and a get when it has a key; a served report a
// list (with its row cap, and its export when `report-export` is wired). Every many-to-many
// relationship of a covered entity gets a traversal query. An entity also gets a command per
// transition that derives one (ADR-0066 §2, under `rules.lifecycle.commands`), and the package's
// declared operations that act on a covered entity or on none.

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
  type MetaRoot,
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
import { generatableObjects, hasWritableRdbSource } from "./source-detect.js";
import { isAbstract } from "./instance-artifacts.js";
import { isProjection, isWriteThrough } from "./projection/projection-detector.js";
import { declaresTphDiscriminator, isTphSubtype, tphDiscriminatorBase, tphDiscriminatorPin, tphStorageObject } from "./tph.js";
import { isReport } from "./source-detect.js";
import { itemRouteField, servesReadApi } from "./api-surface.js";
import { tphPlan } from "./templates/tph-discriminator.js";
import { buildRelationMap, type RelationMap } from "./relation-resolver.js";
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

/** What kind of object a service entity is: a writable entity, or a read-only projection or report. */
export type ServiceObjectKind = "entity" | "projection" | "report";

/** A single-table subtype's scope: its rows are the base table's rows whose `field` holds `value`. */
export interface ServiceDiscriminator {
  readonly field: string;
  readonly value: string;
}

/** A many-to-many traversal of a covered entity (FR-018): `GET <path>/:id/<name>`. */
export interface ServiceRelation {
  /** The service function: `<relation>Of<Entity>` (`tagsOfPost`). */
  readonly fn: string;
  /** The relationship's name: the path segment. */
  readonly name: string;
  readonly junction: MetaObject;
  /** The junction's field holding the source key, and the one holding the target key. */
  readonly sourceJoinField: string;
  readonly targetJoinField: string;
  /** The object whose table holds the target rows (a single-table subtype's base). */
  readonly target: MetaObject;
  /** The objects whose fields the target rows carry: the target, and a TPH base's subtypes. */
  readonly targetObjects: readonly MetaObject[];
  /** The target is a single-table subtype: only rows of its discriminator value. */
  readonly targetDiscriminator: ServiceDiscriminator | undefined;
  /** Undirected self-join: both junction columns are read. */
  readonly symmetric: boolean;
}

/** One entity's service operations. */
export interface ServiceEntity {
  readonly obj: MetaObject;
  /** The field the primary identity names: the key a get, update or delete takes. */
  readonly keyField: string;
  /** The function name of each derived operation (`listAuthors`, `getAuthor`, ...). */
  readonly operations: Readonly<Record<DerivedOperation, string>>;
  /** The derived operations it has, in `DERIVED_OPERATIONS` order. */
  readonly verbs: readonly DerivedOperation[];
  readonly kind: ServiceObjectKind;
  /**
   * The object whose entity module exports the table the operations read and write: the object
   * itself, or a single-table subtype's discriminator base. A projection or report reads its view.
   */
  readonly storage: MetaObject;
  /** A write-through entity: reads go through its replica view, and a write is read back through it. */
  readonly readView: boolean;
  /** The REST path, before the API prefix (`/auths/bridge` for a single-table subtype). */
  readonly path: string;
  /** A single-table subtype's scope. */
  readonly discriminator: ServiceDiscriminator | undefined;
  /** The objects of its single-table hierarchy (the base and every concrete subtype), else just itself. */
  readonly hierarchy: readonly MetaObject[];
  /** Its many-to-many traversals. */
  readonly relations: readonly ServiceRelation[];
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
  /**
   * False when the store cannot hold a transaction across application code (Cloudflare D1): the
   * service generator's `interactiveTransactions` option, not the model's. Absent: true.
   */
  readonly interactiveTransactions?: boolean;
  /** A served report's row cap: the service generator's `reportMaxRows` option. Absent: 10000, the same in every port. */
  readonly reportMaxRows?: number;
}

export interface ServiceWalkOpts {
  /** Narrow which objects are covered (the generator's `filter` and the run's selection). */
  matches?: (obj: MetaObject) => boolean;
}

/** Whether `obj` gets service operations: every object the flat routes serve, with a single key where it has one. */
export function hasServiceOperations(obj: MetaObject): boolean {
  if (!servesReadApi(obj)) return false;
  if (isProjection(obj)) return true;
  if (obj.subType !== OBJECT_SUBTYPE_ENTITY || !hasWritableRdbSource(obj)) return false;
  return serviceKeyField(obj) !== undefined;
}

/** The verbs, storage, path and scope of a covered object. */
function shapeOf(obj: MetaObject, root: MetaRoot): Pick<ServiceEntity, "kind" | "verbs" | "storage" | "readView" | "path" | "discriminator" | "hierarchy"> {
  const path = restPath(obj);
  if (isProjection(obj)) {
    const keyed = itemRouteField(obj) !== undefined;
    return { kind: isReport(obj) ? "report" : "projection", verbs: keyed ? ["list", "get"] : ["list"], storage: obj, readView: false, path, discriminator: undefined, hierarchy: [obj] };
  }
  const pin = tphDiscriminatorPin(obj);
  const base = tphDiscriminatorBase(obj);
  if (pin !== undefined && base !== undefined) {
    const plan = tphPlan(base, root);
    const hierarchy = plan === null ? [base, obj] : [base, ...plan.subtypes.map((st) => st.entity)];
    return { kind: "entity", verbs: DERIVED_OPERATIONS, storage: base, readView: false, path, discriminator: { field: pin.fieldName, value: pin.value }, hierarchy };
  }
  const plan = declaresTphDiscriminator(obj) ? tphPlan(obj, root) : null;
  if (plan !== null) {
    // The polymorphic base is read-only by construction: the union has no single writable shape.
    return { kind: "entity", verbs: ["list", "get"], storage: obj, readView: false, path, discriminator: undefined, hierarchy: [obj, ...plan.subtypes.map((st) => st.entity)] };
  }
  return { kind: "entity", verbs: DERIVED_OPERATIONS, storage: obj, readView: isWriteThrough(obj), path, discriminator: undefined, hierarchy: [obj] };
}

/** The many-to-many traversals `obj` resolves (the relation map's rule, the flat routes' too). */
function relationsOf(obj: MetaObject, relationMap: RelationMap, root: MetaRoot): ServiceRelation[] {
  const out: ServiceRelation[] = [];
  for (const e of relationMap.get(obj.name) ?? []) {
    if (e.junction === undefined || e.sourceJoinField === undefined || e.targetJoinField === undefined) continue;
    const target = tphStorageObject(e.target);
    const plan = declaresTphDiscriminator(e.target) ? tphPlan(e.target, root) : null;
    const pin = tphDiscriminatorPin(e.target);
    out.push({
      fn: `${toCamelCase(e.name)}Of${obj.name}`,
      name: e.name,
      junction: e.junction,
      sourceJoinField: e.sourceJoinField,
      targetJoinField: e.targetJoinField,
      target,
      targetObjects: plan === null ? [e.target] : [e.target, ...plan.subtypes.map((st) => st.entity)],
      targetDiscriminator: pin === undefined ? undefined : { field: pin.fieldName, value: pin.value },
      symmetric: e.symmetric === true,
    });
  }
  return out;
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
export function serviceModelOf(root: MetaRoot, opts: ServiceWalkOpts = {}): ServicePackage[] {
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
  const relationMap = buildRelationMap(root);
  // A served report is read through its read model (its derived fields as real fields), the
  // object every other generator is handed; a report that is not served has no API.
  for (const obj of generatableObjects(root.children().filter(isMetaObject), root)) {
    if (!hasServiceOperations(obj) || !matches(obj)) continue;
    const shape = shapeOf(obj, root);
    const rules = shape.kind === "entity" ? entityRules(obj, claimed, settings) : { lifecycles: [], commands: [] };
    const keyField = shape.kind === "entity" ? serviceKeyField(obj)! : (itemRouteField(obj) ?? "id");
    const e: ServiceEntity = { obj, keyField, operations: serviceOperationNames(obj), ...shape, relations: relationsOf(obj, relationMap, root), ...rules };
    covered.set(obj, e);
    bucket(effectivePackage(obj) ?? "").entities.push(e);
  }
  // One operation declared identically by two APIs (a versioned API) is one operation (O6). An
  // operation whose target has no derived operations (a composite key) has none either.
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

/** The function that mounts package `pkg`'s service routes on a Hono app: `<type, first letter lowered>HonoRoutes`. */
export function serviceHonoRoutesName(pkg: string): string {
  const type = serviceTypeName(pkg);
  return `${type.charAt(0).toLowerCase()}${type.slice(1)}HonoRoutes`;
}

/** The Hono transport's file in {@link TRANSPORT_DIR}. */
export const HONO_TRANSPORT_FILE = "hono.ts";

/** Where package `pkg`'s Hono transport goes, relative to the target's outDir. */
export function honoTransportPath(pkg: string): string {
  const dir = packageToPath(pkg);
  return dir === "" ? `${TRANSPORT_DIR}/${HONO_TRANSPORT_FILE}` : `${dir}/${TRANSPORT_DIR}/${HONO_TRANSPORT_FILE}`;
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
