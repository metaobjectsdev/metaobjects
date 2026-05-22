import type { Generator } from "./generator.js";
import type { ExtStyle } from "./render-context.js";
import type { OutputLayout, ResolvedTarget } from "./import-path.js";

export type Dialect = "sqlite" | "postgres";
export type ColumnNamingStrategy = "snake_case" | "literal" | "kebab-case";
export type { ExtStyle };
export type { OutputLayout };
export type { ResolvedTarget };

/** The implicit target synthesized from top-level config (outDir/outputLayout/dbImport). */
export const DEFAULT_TARGET_NAME = "default";

/** User-facing per-target output config. */
export interface TargetConfig {
  outDir: string;
  importBase?: string;
  outputLayout?: OutputLayout;
  dbImport?: string;
}

/** Subset of MetaobjectsGenConfig surfaced to generators via GenContext. */
export interface ResolvedGenConfig {
  outDir: string;
  extStyle: ExtStyle;
  dbImport: string;
  dialect: Dialect;
  /** "flat" (default) — all files in outDir; "package" — files placed in a sub-path derived from each entity's metadata package. */
  outputLayout?: OutputLayout;
}

export interface MetaobjectsGenConfig extends ResolvedGenConfig {
  generators: Generator[];
  /** How field names map to DB column names when @dbColumn is omitted. Defaults to "snake_case". */
  columnNamingStrategy?: ColumnNamingStrategy;
  /** Path prefix applied to generated route registrations + hook fetch URLs. Defaults to "". */
  apiPrefix?: string;
  /** Named output destinations. Generators reference one via `target`. */
  targets?: Record<string, TargetConfig>;
  /** importBase for the default target (top-level outDir). */
  importBase?: string;
}

/** MetaobjectsGenConfig after applying defaults. All fields required.
 *  `targets` is Omitted from the base so it can narrow from the user-facing
 *  TargetConfig to the fully-resolved ResolvedTarget (incompatible under
 *  exactOptionalPropertyTypes otherwise). */
export interface NormalizedMetaobjectsGenConfig extends Omit<MetaobjectsGenConfig, "targets"> {
  columnNamingStrategy: ColumnNamingStrategy;
  apiPrefix: string;
  outputLayout: OutputLayout;
  targets: Record<string, ResolvedTarget>;
}

/** Identity passthrough; exists for IDE type-inference + autocomplete. */
export function defineConfig(config: MetaobjectsGenConfig): MetaobjectsGenConfig {
  return config;
}

/** Synthesize the implicit "default" target from top-level fields and resolve
 *  each named target (outputLayout + dbImport fall back to top-level;
 *  importBase does NOT inherit — it is a per-target identity). */
export function resolveTargets(config: MetaobjectsGenConfig): Record<string, ResolvedTarget> {
  const layout: OutputLayout = config.outputLayout ?? "flat";
  const out: Record<string, ResolvedTarget> = {
    [DEFAULT_TARGET_NAME]: {
      name: DEFAULT_TARGET_NAME,
      outDir: config.outDir,
      importBase: config.importBase,
      outputLayout: layout,
      dbImport: config.dbImport,
    },
  };
  for (const [name, t] of Object.entries(config.targets ?? {})) {
    out[name] = {
      name,
      outDir: t.outDir,
      importBase: t.importBase,
      outputLayout: t.outputLayout ?? layout,
      dbImport: t.dbImport ?? config.dbImport,
    };
  }
  return out;
}

/** Apply defaults to a MetaobjectsGenConfig, returning a NormalizedMetaobjectsGenConfig. */
export function normalizeConfig(config: MetaobjectsGenConfig): NormalizedMetaobjectsGenConfig {
  return {
    ...config,
    columnNamingStrategy: config.columnNamingStrategy ?? "snake_case",
    apiPrefix: config.apiPrefix ?? "",
    outputLayout: config.outputLayout ?? "flat",
    targets: resolveTargets(config),
  };
}
