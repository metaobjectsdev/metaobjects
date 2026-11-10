// RenderContext — cross-cutting state passed to every template.

import type { MetaRoot, MetaData } from "@metaobjectsdev/metadata";
import { FIELD_ATTR_OBJECT_REF, PACKAGE_SEPARATOR, TYPE_OBJECT, collectionNameOf, declaredCollectionName, physicalNamingOf, refTarget, stripPackage } from "@metaobjectsdev/metadata";
import type { Dialect } from "./column-mapper.js";
import { normalizeTimestampMode } from "./dialect-module.js";
import type { PkInfo } from "./pk-resolver.js";
import type { RelationMap } from "./relation-resolver.js";
import type { ColumnNamingStrategy } from "./metaobjects-config.js";
import { DEFAULT_OUTPUT_LAYOUT, type OutputLayout, type ResolvedTarget } from "./import-path.js";
import { toCamelCase, variableNameFromEntity } from "./naming.js";

/**
 * The local name a file uses for `obj` when it imports it: `obj.name`, or — when another
 * top-level object in the model shares that short name — its package PascalCased and prefixed
 * (`acme::alpha::Note` → `AcmeAlphaNote`), imported `as` that alias. Only the local binding
 * carries the package; the declared type keeps its name (ruling R52).
 */
export function localTypeName(obj: MetaData, root: MetaData): string {
  const shares = root.children().filter((c) => c.type === TYPE_OBJECT && c.name === obj.name).length > 1;
  // The effective package, read off the resolution key (`docs-paths.ts` effectivePackage).
  const key = obj.resolutionKey();
  const suffix = `${PACKAGE_SEPARATOR}${obj.name}`;
  const pkg = key.endsWith(suffix) ? key.slice(0, -suffix.length) : "";
  if (!shares || pkg === "") return obj.name;
  return pkg.split(PACKAGE_SEPARATOR).map((s) => (s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s)).join("") + obj.name;
}

/**
 * How to format relative import specifiers in generated files.
 *   - "js"   → emit `"./Foo.js"`. **Default.** Required by Node ESM strict + TS
 *              NodeNext/node16, and also accepted by moduleResolution
 *              "bundler"/"node", tsx, drizzle-kit's TS loader, Vite, and esbuild —
 *              so it is the strictly-more-compatible default (a stock `tsc --init`
 *              defaults to nodenext, under which un-extensioned imports fail TS2835).
 *   - "none" → emit `"./Foo"`. Opt out via `codegen.extStyle = "none"` when your
 *              toolchain forbids `.js` specifiers (rare — most bundlers accept both).
 */
export type ExtStyle = "js" | "none";

export interface RenderContext {
  dialect: Dialect;
  loadedRoot: MetaRoot;
  outDir: string;
  /**
   * Import path for { db } in generated .queries.ts files.
   * E.g. '~/server/db'. Set via forge.config.ts codegen.dbImport.
   */
  dbImport: string;
  /**
   * Import path for { om } in generated .routes.ts files.
   * E.g. '../index' or '@your-pkg/database'. The module is expected to export
   * an `om()` function returning a Promise<ObjectManager>.
   * Defaults to '../index' (one level up from outDir).
   */
  omImport: string;
  /** Cross-entity import-specifier style. Defaults to "js" (Node-ESM-safe). */
  extStyle: ExtStyle;
  /** Column naming strategy: how field names map to DB column names. Defaults to "snake_case". */
  columnNamingStrategy: ColumnNamingStrategy;
  /**
   * Drizzle timestamp column mode. "string" (default) types timestamp columns as
   * ISO-8601 strings (matching the generated Zod + cross-port wire contract);
   * "date" uses drizzle's native JS-Date mode (for consumers whose hand-written
   * code works with `Date`). Opt in via `codegen.timestampMode`.
   *
   * Postgres-only — normalized to "string" for `dialect === "sqlite"` (covers D1)
   * at the `makeRenderContext` / `normalizeConfig` choke points; see the fuller
   * doc comment on `MetaobjectsGenConfig.timestampMode` in metaobjects-config.ts.
   */
  timestampMode: "date" | "string";
  /**
   * Prepend `"use client";` to generated CLIENT artifacts (forms, hooks, grid
   * columns, grid hooks). Defaults to false. A bundler-topology fact the adopter
   * declares — see `MetaobjectsGenConfig.clientDirective` for why it is config
   * rather than metadata, and why the default is off. FR-040 §6.4.
   */
  clientDirective: boolean;
  /** Path prefix applied to generated route registrations + hook fetch URLs. Defaults to "". */
  apiPrefix: string;
  /** Whether abstract entities emit their shape artifact (type-only interface / value-object file). Defaults to true. Instance/write artifacts are never emitted for abstract entities regardless. */
  emitAbstractShapes: boolean;
  /** Output layout mode: "package" (default, R63) — sub-paths from entity metadata package; "flat" — all files in outDir. */
  outputLayout: OutputLayout;
  /**
   * §A6 — whether the run emits the `<Entity>Names` artifact (the runner aggregates the
   * suite's `emitsNames` markers; `ctx.config.includeNames` carries the same fact for
   * generators). A template may reference those constants ONLY when this is true: the
   * names generator is opt-in under ADR-0034 scaffold-and-own, so an unconditional
   * import would break every project that has not enabled it. Defaults to FALSE, which
   * is what keeps output byte-identical for such a project — and for every bare-context
   * caller (unit tests, generators invoked outside runGen).
   */
  includeNames: boolean;
  /** Whether the `report-export` generator is wired for this target. A report's route file mounts
   *  the `?format=` branch and imports `<Report>.export` only when true; false keeps the output
   *  byte-identical to a project that wires none. */
  includeReportExport: boolean;
  /**
   * Resolve an entity name to its Drizzle collection (table) variable name,
   * applying the project's pluralization config + per-entity overrides. Every
   * template that emits or references a table var goes through this so the
   * declaration and all references agree. Defaults to always-pluralize.
   */
  collectionName: (entityName: string) => string;
  /** The target THIS generator emits to (drives path layout + same-target imports). */
  selfTarget: ResolvedTarget;
  /** Where entity files live (drives cross-target entity imports). */
  entityModuleTarget: ResolvedTarget;
  pkMap: Map<string, PkInfo>;
  /** Pre-pass relation map for FK + relations() block emission. */
  relationMap: RelationMap;
  /** The name a value object is DECLARED under (its interface, Zod schema and module file):
   *  its own name. A value object is never renamed (ruling R52); a real collision is refused
   *  by the run's claim registry. */
  valueObjectEmittedName: (obj: MetaData) => string;
  /** The value object a field's `@objectRef` names, as the loader bound it (ADR-0059 R7:
   *  resolved where the attribute was declared). Undefined when it resolves to nothing. */
  resolveValueObject: (field: MetaData) => MetaData | undefined;
  /** The LOCAL name a referencing file uses for the value object a field's `@objectRef` names:
   *  its own name, or its package-qualified name when another object in the model shares the
   *  short name (imported `as` that alias, so two same-named value objects can meet in one
   *  file). Falls back to the bare (package-stripped) ref when it resolves to nothing. */
  resolveValueObjectName: (field: MetaData) => string;
  /** FR-019: module specifier to import externally-PROVIDED shared enums from
   *  (`@provided: true` declarations). Undefined when unset — referencing a
   *  provided enum without it is a codegen-time error. */
  providedEnumModule?: string;
  /**
   * Where the HTTP-adapter tier (`drizzle-fastify` / `hono` mounts and the allowlist
   * types) is imported from — see `owned-runtime.ts`. Undefined = the
   * `@metaobjectsdev/runtime-ts` package, which is what the runner always builds, so
   * output is byte-identical for every project that has not ejected. An owned generator
   * sets it (`{ ...ctx.renderContext, httpRuntimeImport }`) to point its output at the
   * adapter copy `meta eject` placed in the repo.
   */
  httpRuntimeImport?: string;
}

/** Optional shape — `extStyle`, `omImport`, `columnNamingStrategy`, `apiPrefix` and `outputLayout` default if omitted. `collectionName` is built from `pluralizeCollections` + `collectionNameOverrides` (both default to always-pluralize). */
export type RenderContextInput = Omit<RenderContext, "extStyle" | "omImport" | "columnNamingStrategy" | "timestampMode" | "clientDirective" | "apiPrefix" | "emitAbstractShapes" | "outputLayout" | "includeNames" | "includeReportExport" | "valueObjectEmittedName" | "resolveValueObject" | "resolveValueObjectName" | "selfTarget" | "entityModuleTarget" | "collectionName"> & {
  extStyle?: ExtStyle;
  omImport?: string;
  columnNamingStrategy?: ColumnNamingStrategy;
  timestampMode?: "date" | "string";
  clientDirective?: boolean;
  apiPrefix?: string;
  emitAbstractShapes?: boolean;
  outputLayout?: OutputLayout;
  includeNames?: boolean;
  includeReportExport?: boolean;
  selfTarget?: ResolvedTarget;
  entityModuleTarget?: ResolvedTarget;
  /** Auto-pluralize collection (table) variable names. Default true. */
  pluralizeCollections?: boolean;
  /** Per-entity exact collection-var-name overrides, keyed by bare entity name. */
  collectionNameOverrides?: Record<string, string>;
};

/** Append the configured extension to a cross-entity module specifier (which is
 *  always a bare, extension-less relative path like `./Foo`). */
export function withExt(spec: string, style: ExtStyle): string {
  return style === "js" ? `${spec}.js` : spec;
}

/**
 * Apply the extension style to a possibly-user-supplied module specifier
 * (`dbImport`, `providedEnumModule`, …). Unlike {@link withExt}, this only touches
 * RELATIVE specifiers and never double-appends: a bare package/alias specifier
 * (`@acme/db`, `~/server/db`) is depth- and extension-invariant, and a specifier
 * the author already extensioned (`../db.js`) is left as-is.
 */
export function withExtIfRelative(spec: string, style: ExtStyle): string {
  if (style !== "js") return spec;
  const isRelative = spec.startsWith("./") || spec.startsWith("../");
  if (!isRelative) return spec;
  if (/\.(js|jsx|mjs|cjs|ts|tsx|json)$/.test(spec)) return spec;
  return `${spec}.js`;
}

/** Thin factory; applies sensible defaults for fields the caller may omit. */
export function makeRenderContext(opts: RenderContextInput): RenderContext {
  const outputLayout = opts.outputLayout ?? DEFAULT_OUTPUT_LAYOUT;
  const defaultTarget: ResolvedTarget = opts.selfTarget ?? {
    name: "default",
    outDir: opts.outDir,
    importBase: undefined,
    outputLayout,
    dbImport: opts.dbImport,
    runtime: true,
  };
  // rc.19 (R57): an object's collection name (@collectionName, or a configured pluralizer) names
  // its Drizzle collection variable too, lowerFirst; the TS config's own overrides still win.
  const modelCollections: Record<string, string> = {};
  if (opts.pluralizeCollections !== false) {
    const configured = physicalNamingOf(opts.loadedRoot).collections;
    for (const obj of opts.loadedRoot.objects()) {
      if (configured === undefined && declaredCollectionName(obj) === undefined) continue;
      const name = collectionNameOf(obj);
      modelCollections[obj.name] = toCamelCase(name.charAt(0).toLowerCase() + name.slice(1));
    }
  }
  const collectionNameOpts = {
    pluralize: opts.pluralizeCollections ?? true,
    overrides: { ...modelCollections, ...(opts.collectionNameOverrides ?? {}) },
  };
  const resolveValueObject = (field: MetaData): MetaData | undefined => refTarget(field, FIELD_ATTR_OBJECT_REF);
  return {
    ...opts,
    extStyle: opts.extStyle ?? "js",
    omImport: opts.omImport ?? "../index",
    // ADR-0058: the project's one setting, carried by the loaded root.
    columnNamingStrategy: opts.columnNamingStrategy ?? physicalNamingOf(opts.loadedRoot).columns,
    // "date" mode is Postgres-only — normalize to "string" on sqlite/D1 here too
    // (the OTHER choke point besides normalizeConfig; a bare-context caller, e.g.
    // a unit test or a generator invoked outside `runGen`, must get the same
    // safe-no-op guarantee). See MetaobjectsGenConfig.timestampMode's doc comment.
    timestampMode: normalizeTimestampMode(opts.dialect, opts.timestampMode),
    clientDirective: opts.clientDirective ?? false,
    apiPrefix: opts.apiPrefix ?? "",
    emitAbstractShapes: opts.emitAbstractShapes ?? true,
    outputLayout,
    includeNames: opts.includeNames ?? false,
    includeReportExport: opts.includeReportExport ?? false,
    valueObjectEmittedName: (obj: MetaData) => obj.name,
    resolveValueObject,
    resolveValueObjectName: (field: MetaData) => {
      const node = resolveValueObject(field);
      if (node !== undefined) return localTypeName(node, opts.loadedRoot);
      // ADR-0039: resolving — @objectRef may be inherited via extends.
      const ref = field.attr(FIELD_ATTR_OBJECT_REF);
      return stripPackage(typeof ref === "string" ? ref : "");
    },
    selfTarget: defaultTarget,
    entityModuleTarget: opts.entityModuleTarget ?? defaultTarget,
    collectionName: (entityName: string) => variableNameFromEntity(entityName, collectionNameOpts),
  };
}
