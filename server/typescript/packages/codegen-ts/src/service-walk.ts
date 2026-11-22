// What the service layer covers (ADR-0067 §1, layer 4), for one model.
//
// Engine, not emit: `serviceFile()` and `serviceRoutesFile()` render these records, and an ejected
// copy of either keeps calling this walk, so which objects get a service operation, what the
// operations are named and where their files go stays packaged while the files' shape is the
// adopter's.
//
// Covered: every concrete `object.entity` whose primary source is a writable `source.rdb`, keyed
// by a single-field primary identity. It gets the five derived operations: list, get, create,
// update and delete. Not covered yet: a write-through entity (reads through a replica view), a
// single-table (TPH) hierarchy, many-to-many traversal, projections and reports, and the
// transition commands and declared operations of ADR-0066 (later service work, which adds the
// policy, bodies and events interfaces).

import { IDENTITY_ATTR_FIELDS, isMetaObject, OBJECT_SUBTYPE_ENTITY, type MetaData, type MetaObject } from "@metaobjectsdev/metadata";
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

/** One entity's service operations. */
export interface ServiceEntity {
  readonly obj: MetaObject;
  /** The field the primary identity names: the key a get, update or delete takes. */
  readonly keyField: string;
  /** The function name of each derived operation (`listAuthors`, `getAuthor`, ...). */
  readonly operations: Readonly<Record<DerivedOperation, string>>;
}

/** One metadata package's service module. */
export interface ServicePackage {
  readonly package: string;
  readonly entities: readonly ServiceEntity[];
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

/** The service modules of `root`, one per package that has a covered entity, sorted by package. */
export function serviceModelOf(root: MetaData, opts: ServiceWalkOpts = {}): ServicePackage[] {
  const matches = opts.matches ?? (() => true);
  const packages = new Map<string, ServiceEntity[]>();
  for (const obj of root.children().filter(isMetaObject)) {
    if (!hasServiceOperations(obj) || !matches(obj)) continue;
    const pkg = effectivePackage(obj) ?? "";
    const list = packages.get(pkg) ?? [];
    packages.set(pkg, list);
    list.push({ obj, keyField: serviceKeyField(obj)!, operations: serviceOperationNames(obj) });
  }
  return [...packages.keys()].sort().map((pkg) => ({ package: pkg, entities: packages.get(pkg)! }));
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
