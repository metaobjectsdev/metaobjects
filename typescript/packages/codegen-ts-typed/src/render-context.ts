// Typed-view RenderContext — the POC parallel to codegen-ts/src/render-context.ts.
// loadedRoot is a MetaRoot typed view, not a raw MetaData.

import type { MetaRoot } from "@metaobjects/metadata";
import type { Dialect, ColumnNamingStrategy } from "@metaobjects/codegen-ts";
import type { PkInfo } from "./pk-resolver.js";
import type { RelationMap } from "./relation-resolver.js";

export type ExtStyle = "js" | "none";

export interface RenderContext {
  dialect: Dialect;
  loadedRoot: MetaRoot;
  outDir: string;
  dbImport: string;
  omImport: string;
  extStyle: ExtStyle;
  columnNamingStrategy: ColumnNamingStrategy;
  apiPrefix: string;
  pkMap: Map<string, PkInfo>;
  relationMap: RelationMap;
}

/** Append the configured extension to a cross-entity module specifier. */
export function withExt(spec: string, style: ExtStyle): string {
  return style === "js" ? `${spec}.js` : spec;
}
