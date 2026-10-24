// Load every JSON metadata file in a directory through the standard loader.
// Errors are aggregated and re-thrown with the directory + error codes so a
// scenario failure points at the right fixture immediately.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_WIRE_FORMAT, loadDirectory, loadUris, type MetaRoot, type WireFormat } from "@metaobjectsdev/metadata";
import { ConfigSchema, physicalNamingFromConfig, wireFormatFromConfig, type Config } from "@metaobjectsdev/sdk";

/**
 * ADR-0058 — set `root`'s physical naming and wire format from the nearest `.metaobjects/config.json` at or
 * above `startDir`, as a project-aware load does. A corpus that pins a committed schema
 * declares the naming that schema uses there, and every port's runner reads that one file.
 * No file up to the repository root leaves the default.
 */
export function applyNearestNaming(root: MetaRoot, startDir: string): MetaRoot {
  const config = nearestConfig(startDir);
  if (config === undefined) return root;
  root.physicalNaming = physicalNamingFromConfig(config);
  // ADR-0019 Amendment 2: the corpus pins its wire form in the same file, so generated
  // routes are emitted with it and no lane carries a literal.
  root.wireFormat = wireFormatFromConfig(config);
  return root;
}

/** The nearest `.metaobjects/config.json` at or above `startDir`, never past the repository. */
export function nearestConfig(startDir: string): Config | undefined {
  for (let dir = startDir; ; dir = dirname(dir)) {
    const file = join(dir, ".metaobjects", "config.json");
    if (existsSync(file)) return ConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    // Never past the repository: a config above it belongs to something else.
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir) return undefined;
  }
}

/** The wire format a hand-rolled reference server mounts with: the corpus's own, from its config. */
export function nearestWireFormat(startDir: string): WireFormat {
  const config = nearestConfig(startDir);
  return config === undefined ? DEFAULT_WIRE_FORMAT : wireFormatFromConfig(config);
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
