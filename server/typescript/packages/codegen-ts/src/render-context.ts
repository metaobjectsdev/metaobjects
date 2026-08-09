// RenderContext — cross-cutting state passed to every template.

import type { MetaRoot, MetaData, MetaField } from "@metaobjectsdev/metadata";
import { resolveObjectRef, stripPackage } from "@metaobjectsdev/metadata";
import type { Dialect } from "./column-mapper.js";
import type { PkInfo } from "./pk-resolver.js";
import type { RelationMap } from "./relation-resolver.js";
import type { ColumnNamingStrategy } from "./metaobjects-config.js";
import type { OutputLayout, ResolvedTarget } from "./import-path.js";
import { variableNameFromEntity } from "./naming.js";

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
  /** Path prefix applied to generated route registrations + hook fetch URLs. Defaults to "". */
  apiPrefix: string;
  /** Whether abstract entities emit their shape artifact (type-only interface / value-object file). Defaults to true. Instance/write artifacts are never emitted for abstract entities regardless. */
  emitAbstractShapes: boolean;
  /** Output layout mode: "flat" (default) — all files in outDir; "package" — sub-paths from entity metadata package. */
  outputLayout: OutputLayout;
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
  /** Object name → its metadata package (undefined if the object has no package).
   *  Built once per run. Value objects are keyed by their ADR-0044 EMITTED name
   *  (bare when unique, package-qualified on a cross-package short-name collision;
   *  #228) so `valueObjectModuleSpecifier` resolves the right module; entities and
   *  other objects are keyed by their bare name. */
  packageOf: Map<string, string | undefined>;
  /** ADR-0044/#228 — `resolutionKey()` → emitted TS name for every emitted
   *  `object.value` in the run. A PURE function of the run's value-object set
   *  (collision-scoped): a bare short name unique in the set stays bare; a
   *  cross-package short-name collision qualifies EVERY member. Empty by default
   *  (bare names — byte-identical to pre-#228 output). */
  valueObjectNames: ReadonlyMap<string, string>;
  /** The ADR-0044 emitted name for a value object being DECLARED (its interface,
   *  Zod schema, and module filename). Non-value objects (entities) are never in
   *  the collision set, so this returns their bare `name`. */
  valueObjectEmittedName: (obj: MetaData) => string;
  /** The ADR-0044 emitted name for a REFERENCE to a value object (`@objectRef`,
   *  bare or FQN), resolved package-locally (ADR-0042) from `referrerPkg`. Falls
   *  back to the bare (package-stripped) ref when it resolves to no emitted value
   *  object — which is also the byte-identical result whenever there is no
   *  collision. */
  resolveValueObjectName: (ref: string, referrerPkg: string | undefined) => string;
  /** FR-019: module specifier to import externally-PROVIDED shared enums from
   *  (`@provided: true` declarations). Undefined when unset — referencing a
   *  provided enum without it is a codegen-time error. */
  providedEnumModule?: string;
}

/** Optional shape — `extStyle`, `omImport`, `columnNamingStrategy`, `apiPrefix`, `outputLayout`, and `packageOf` default if omitted. `packageOf` defaults to an empty Map (correct for flat layout; `runGen` always provides the real map). `collectionName` is built from `pluralizeCollections` + `collectionNameOverrides` (both default to always-pluralize). */
export type RenderContextInput = Omit<RenderContext, "extStyle" | "omImport" | "columnNamingStrategy" | "timestampMode" | "apiPrefix" | "emitAbstractShapes" | "outputLayout" | "packageOf" | "valueObjectNames" | "valueObjectEmittedName" | "resolveValueObjectName" | "selfTarget" | "entityModuleTarget" | "collectionName"> & {
  extStyle?: ExtStyle;
  omImport?: string;
  columnNamingStrategy?: ColumnNamingStrategy;
  timestampMode?: "date" | "string";
  apiPrefix?: string;
  emitAbstractShapes?: boolean;
  outputLayout?: OutputLayout;
  packageOf?: Map<string, string | undefined>;
  /** ADR-0044/#228 value-object emitted-name map (resolutionKey → emitted name).
   *  Defaults to an empty Map — bare names, byte-identical to pre-#228 output.
   *  `runGen` always provides the real map. */
  valueObjectNames?: ReadonlyMap<string, string>;
  selfTarget?: ResolvedTarget;
  entityModuleTarget?: ResolvedTarget;
  /** Auto-pluralize collection (table) variable names. Default true. */
  pluralizeCollections?: boolean;
  /** Per-entity exact collection-var-name overrides, keyed by bare entity name. */
  collectionNameOverrides?: Record<string, string>;
};

/** ADR-0042/#228 — the package a field's `@objectRef` resolves in: the FIELD's OWN
 *  declaring package (which differs from the referring object's when the field is
 *  inherited via `extends` from an abstract node in another package), falling back
 *  to `fallbackPkg` (the referring object's package). THE single source of truth for
 *  the referrer package passed to `RenderContext.resolveValueObjectName`, so every
 *  value-object reference site resolves a cross-package short-name collision
 *  identically (they cannot drift). Mirrors payload-codegen's `collectClosure`. */
export function fieldDeclaringPackage(field: MetaField, fallbackPkg: string | undefined): string | undefined {
  return field.parent?.package ?? field.parent?.fileDefaultPackage ?? fallbackPkg;
}

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
  const outputLayout = opts.outputLayout ?? "flat";
  const defaultTarget: ResolvedTarget = opts.selfTarget ?? {
    name: "default",
    outDir: opts.outDir,
    importBase: undefined,
    outputLayout,
    dbImport: opts.dbImport,
    runtime: true,
  };
  const collectionNameOpts = {
    pluralize: opts.pluralizeCollections ?? true,
    overrides: opts.collectionNameOverrides ?? {},
  };
  // ADR-0044/#228 — the value-object emitted-name map + its two accessors. When
  // absent (bare template unit-tests), the map is empty, so both accessors return
  // bare names and every consumer is byte-identical to pre-#228 output.
  const valueObjectNames = opts.valueObjectNames ?? new Map<string, string>();
  const loadedRoot = opts.loadedRoot;
  return {
    ...opts,
    extStyle: opts.extStyle ?? "js",
    omImport: opts.omImport ?? "../index",
    columnNamingStrategy: opts.columnNamingStrategy ?? "snake_case",
    // "date" mode is Postgres-only — normalize to "string" on sqlite/D1 here too
    // (the OTHER choke point besides normalizeConfig; a bare-context caller, e.g.
    // a unit test or a generator invoked outside `runGen`, must get the same
    // safe-no-op guarantee). See MetaobjectsGenConfig.timestampMode's doc comment.
    timestampMode: opts.dialect === "sqlite" ? "string" : (opts.timestampMode ?? "string"),
    apiPrefix: opts.apiPrefix ?? "",
    emitAbstractShapes: opts.emitAbstractShapes ?? true,
    outputLayout,
    packageOf: opts.packageOf ?? new Map(),
    valueObjectNames,
    valueObjectEmittedName: (obj: MetaData) => valueObjectNames.get(obj.resolutionKey()) ?? obj.name,
    resolveValueObjectName: (ref: string, referrerPkg: string | undefined) => {
      const { node } = resolveObjectRef(loadedRoot, ref, referrerPkg ?? "");
      const emitted = node !== undefined ? valueObjectNames.get(node.resolutionKey()) : undefined;
      return emitted ?? stripPackage(ref);
    },
    selfTarget: defaultTarget,
    entityModuleTarget: opts.entityModuleTarget ?? defaultTarget,
    collectionName: (entityName: string) => variableNameFromEntity(entityName, collectionNameOpts),
  };
}
