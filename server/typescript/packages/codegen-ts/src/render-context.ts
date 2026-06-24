// RenderContext — cross-cutting state passed to every template.

import type { MetaRoot } from "@metaobjectsdev/metadata";
import type { Dialect } from "./column-mapper.js";
import type { PkInfo } from "./pk-resolver.js";
import type { RelationMap } from "./relation-resolver.js";
import type { ColumnNamingStrategy } from "./metaobjects-config.js";
import type { OutputLayout, ResolvedTarget } from "./import-path.js";
import { variableNameFromEntity } from "./naming.js";

/**
 * How to format cross-entity import specifiers in generated files.
 *   - "none" → emit `"./Foo"`. **Default.** Works for moduleResolution
 *              "bundler"/"node", tsx, drizzle-kit's TS loader, Vite, esbuild,
 *              and almost every modern TS toolchain.
 *   - "js"   → emit `"./Foo.js"`. Required for Node ESM strict + TS NodeNext.
 *              Opt in via `--ext-style js` or `codegen.extStyle = "js"`.
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
  /** Entity name → its metadata package (undefined if the entity has no package). Built once per run. */
  packageOf: Map<string, string | undefined>;
  /** FR-019: module specifier to import externally-PROVIDED shared enums from
   *  (`@provided: true` declarations). Undefined when unset — referencing a
   *  provided enum without it is a codegen-time error. */
  providedEnumModule?: string;
}

/** Optional shape — `extStyle`, `omImport`, `columnNamingStrategy`, `apiPrefix`, `outputLayout`, and `packageOf` default if omitted. `packageOf` defaults to an empty Map (correct for flat layout; `runGen` always provides the real map). `collectionName` is built from `pluralizeCollections` + `collectionNameOverrides` (both default to always-pluralize). */
export type RenderContextInput = Omit<RenderContext, "extStyle" | "omImport" | "columnNamingStrategy" | "timestampMode" | "apiPrefix" | "emitAbstractShapes" | "outputLayout" | "packageOf" | "selfTarget" | "entityModuleTarget" | "collectionName"> & {
  extStyle?: ExtStyle;
  omImport?: string;
  columnNamingStrategy?: ColumnNamingStrategy;
  timestampMode?: "date" | "string";
  apiPrefix?: string;
  emitAbstractShapes?: boolean;
  outputLayout?: OutputLayout;
  packageOf?: Map<string, string | undefined>;
  selfTarget?: ResolvedTarget;
  entityModuleTarget?: ResolvedTarget;
  /** Auto-pluralize collection (table) variable names. Default true. */
  pluralizeCollections?: boolean;
  /** Per-entity exact collection-var-name overrides, keyed by bare entity name. */
  collectionNameOverrides?: Record<string, string>;
};

/** Append the configured extension to a cross-entity module specifier. */
export function withExt(spec: string, style: ExtStyle): string {
  return style === "js" ? `${spec}.js` : spec;
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
  return {
    ...opts,
    extStyle: opts.extStyle ?? "none",
    omImport: opts.omImport ?? "../index",
    columnNamingStrategy: opts.columnNamingStrategy ?? "snake_case",
    timestampMode: opts.timestampMode ?? "string",
    apiPrefix: opts.apiPrefix ?? "",
    emitAbstractShapes: opts.emitAbstractShapes ?? true,
    outputLayout,
    packageOf: opts.packageOf ?? new Map(),
    selfTarget: defaultTarget,
    entityModuleTarget: opts.entityModuleTarget ?? defaultTarget,
    collectionName: (entityName: string) => variableNameFromEntity(entityName, collectionNameOpts),
  };
}
