// RenderContext — cross-cutting state passed to every template.

import type { MetaRoot } from "@metaobjects/metadata";
import type { Dialect } from "./column-mapper.js";
import type { PkInfo } from "./pk-resolver.js";
import type { RelationMap } from "./relation-resolver.js";
import type { ColumnNamingStrategy } from "./metaobjects-config.js";
import type { OutputLayout } from "./import-path.js";

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
  /** Path prefix applied to generated route registrations + hook fetch URLs. Defaults to "". */
  apiPrefix: string;
  /** Output layout mode: "flat" (default) — all files in outDir; "package" — sub-paths from entity metadata package. */
  outputLayout: OutputLayout;
  pkMap: Map<string, PkInfo>;
  /** Pre-pass relation map for FK + relations() block emission. */
  relationMap: RelationMap;
}

/** Optional shape — `extStyle`, `omImport`, `columnNamingStrategy`, `apiPrefix`, and `outputLayout` default if omitted. */
export type RenderContextInput = Omit<RenderContext, "extStyle" | "omImport" | "columnNamingStrategy" | "apiPrefix" | "outputLayout"> & {
  extStyle?: ExtStyle;
  omImport?: string;
  columnNamingStrategy?: ColumnNamingStrategy;
  apiPrefix?: string;
  outputLayout?: OutputLayout;
};

/** Append the configured extension to a cross-entity module specifier. */
export function withExt(spec: string, style: ExtStyle): string {
  return style === "js" ? `${spec}.js` : spec;
}

/** Thin factory; applies sensible defaults for fields the caller may omit. */
export function makeRenderContext(opts: RenderContextInput): RenderContext {
  return {
    ...opts,
    extStyle: opts.extStyle ?? "none",
    omImport: opts.omImport ?? "../index",
    columnNamingStrategy: opts.columnNamingStrategy ?? "snake_case",
    apiPrefix: opts.apiPrefix ?? "",
    outputLayout: opts.outputLayout ?? "flat",
  };
}
