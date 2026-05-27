// Load every JSON metadata file in a directory through the standard loader.
// Errors are aggregated and re-thrown with the directory + error codes so a
// scenario failure points at the right fixture immediately.

import { pathToFileURL } from "node:url";
import { loadDirectory, loadUris, type MetaRoot } from "@metaobjectsdev/metadata";

export async function loadMetadataDir(dir: string): Promise<MetaRoot> {
  const result = await loadDirectory(dir);
  if (result.errors.length > 0) {
    const summary = result.errors
      .map((e) => `${(e as { code?: string }).code ?? "ERROR"}: ${e.message}`)
      .join("; ");
    throw new Error(`${dir}: metadata did not load cleanly: ${summary}`);
  }
  return result.root;
}

/**
 * Load a single metadata file (URI) through the standard loader. Use when
 * the surrounding directory contains non-metadata files (scenario YAML,
 * seed JSON) that the directory loader would mistakenly try to parse.
 */
export async function loadMetadataFile(path: string): Promise<MetaRoot> {
  // loadUris requires a URI scheme; convert the absolute path to file://.
  const result = await loadUris([pathToFileURL(path).href]);
  if (result.errors.length > 0) {
    const summary = result.errors
      .map((e) => `${(e as { code?: string }).code ?? "ERROR"}: ${e.message}`)
      .join("; ");
    throw new Error(`${path}: metadata did not load cleanly: ${summary}`);
  }
  return result.root;
}
