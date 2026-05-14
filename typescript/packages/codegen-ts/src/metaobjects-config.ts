import type { Generator } from "./generator.js";
import type { ExtStyle } from "./render-context.js";

export type Dialect = "sqlite" | "postgres";
export type ColumnNamingStrategy = "snake_case" | "literal" | "kebab-case";
export type { ExtStyle };

/** Subset of MetaobjectsGenConfig surfaced to generators via GenContext. */
export interface ResolvedGenConfig {
  outDir: string;
  extStyle: ExtStyle;
  dbImport: string;
  dialect: Dialect;
}

export interface MetaobjectsGenConfig extends ResolvedGenConfig {
  generators: Generator[];
  /** How field names map to DB column names when @dbColumn is omitted. Defaults to "snake_case". */
  columnNamingStrategy?: ColumnNamingStrategy;
  /** Path prefix applied to generated route registrations + hook fetch URLs. Defaults to "". */
  apiPrefix?: string;
}

/** MetaobjectsGenConfig after applying defaults. All fields required. */
export interface NormalizedMetaobjectsGenConfig extends MetaobjectsGenConfig {
  columnNamingStrategy: ColumnNamingStrategy;
  apiPrefix: string;
}

/** Identity passthrough; exists for IDE type-inference + autocomplete. */
export function defineConfig(config: MetaobjectsGenConfig): MetaobjectsGenConfig {
  return config;
}

/** Apply defaults to a MetaobjectsGenConfig, returning a NormalizedMetaobjectsGenConfig. */
export function normalizeConfig(config: MetaobjectsGenConfig): NormalizedMetaobjectsGenConfig {
  return {
    ...config,
    columnNamingStrategy: config.columnNamingStrategy ?? "snake_case",
    apiPrefix: config.apiPrefix ?? "",
  };
}
