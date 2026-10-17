// Load every JSON metadata file in a directory through the standard loader.
// Errors are aggregated and re-thrown with the directory + error codes so a
// scenario failure points at the right fixture immediately.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadDirectory, loadUris, type MetaRoot } from "@metaobjectsdev/metadata";
import { ConfigSchema, physicalNamingFromConfig } from "@metaobjectsdev/sdk";

/**
 * ADR-0058 — set `root`'s physical naming from the nearest `.metaobjects/config.json` at or
 * above `startDir`, as a project-aware load does. A corpus that pins a committed schema
 * declares the naming that schema uses there, and every port's runner reads that one file.
 * No file up to the repository root leaves the default.
 */
export function applyNearestNaming(root: MetaRoot, startDir: string): MetaRoot {
  for (let dir = startDir; ; dir = dirname(dir)) {
    const file = join(dir, ".metaobjects", "config.json");
    if (existsSync(file)) {
      root.physicalNaming = physicalNamingFromConfig(ConfigSchema.parse(JSON.parse(readFileSync(file, "utf8"))));
      return root;
    }
    // Never past the repository: a config above it belongs to something else.
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir) return root;
  }
}

export async function loadMetadataDir(dir: string): Promise<MetaRoot> {
  const result = await loadDirectory(dir);
  if (result.errors.length > 0) {
    const summary = result.errors
      .map((e) => `${(e as { code?: string }).code ?? "ERROR"}: ${e.message}`)
      .join("; ");
    throw new Error(`${dir}: metadata did not load cleanly: ${summary}`);
  }
  return applyNearestNaming(result.root, dir);
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
  return applyNearestNaming(result.root, dirname(path));
}
