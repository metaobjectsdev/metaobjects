// Module-level loader shortcuts — one-liners that delegate to the
// MetaDataLoader.from* static factories. Per the cross-language convention:
// TS and Python expose both class statics AND module-level shortcuts; Java
// and C# stay class-only.
//
// These functions do not statically import any node:fs- or yaml-using file;
// MetaDataLoader.from* loads the underlying source impls via dynamic import,
// preserving the package root's browser-safety contract.

import { MetaDataLoader } from "./meta-data-loader.js";
import type { LoadOptions, LoadResult } from "./meta-data-loader.js";
import type { MetaDataFormat } from "./meta-data-source.js";

export function loadDirectory(
  dir: string,
  opts?: { exclude?: string[]; recurse?: boolean } & LoadOptions,
): Promise<LoadResult> {
  return MetaDataLoader.fromDirectory(dir, opts);
}

export function loadUris(uris: string[], opts?: LoadOptions): Promise<LoadResult> {
  return MetaDataLoader.fromUris(uris, opts);
}

export function loadString(
  content: string,
  format: MetaDataFormat,
  opts?: LoadOptions,
): Promise<LoadResult> {
  return MetaDataLoader.fromString(content, format, opts);
}
