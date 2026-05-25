// Convenience export API — load a metadata directory and emit one flattened
// canonical-JSON document.
//
// This module wires Loader + canonicalSerialize into a single call so
// consumers (e.g. a React app's build step, the upcoming `meta export` CLI
// command) can go from "a directory of meta.*.json files" to "one JSON
// payload" without having to orchestrate the two steps manually.
//
// Error semantics (match Loader's own conventions):
//   - Content errors (parse/validation failures) are collected in errors[] and
//     returned in the result — they do NOT throw. `json` is still produced from
//     whatever tree the Loader returned (Loader always returns a valid MetaData).
//   - I/O failures (missing/unreadable directory) surface as collected errors
//     via MetaDataLoader.fromDirectory; `loadAndExportJson` surfaces them
//     unchanged in `ExportResult.errors`. It does not throw for directory or
//     metadata problems.

import { MetaDataLoader, type LoadOptions } from "../loader/meta-data-loader.js";
import { canonicalSerialize } from "../serializer-json.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ExportResult {
  /** The single flattened canonical-JSON document of the entire loaded metadata model. */
  json: string;
  /**
   * Parse/validation errors collected during load.
   * Non-empty → `json` may be partial or empty; the caller decides whether to use it.
   */
  errors: Error[];
  /** Non-fatal warnings collected during load. */
  warnings: string[];
}

/**
 * Load all metadata under `dir` and export the entire model as one flattened
 * canonical-JSON document.
 *
 * Routes through `MetaDataLoader.fromDirectory` (using the default registry
 * composed via `composeRegistry(coreProviders)` when none supplied), then
 * serializes the resulting tree with `canonicalSerialize`.
 *
 * @param dir  Absolute or relative path to the directory containing `meta.*.json` files.
 * @param opts Optional loader options (registry, freeze, strict). The
 *             `exclude` glob list can be supplied as `opts.exclude`.
 */
export async function loadAndExportJson(
  dir: string,
  opts?: LoadOptions & { exclude?: string[] },
): Promise<ExportResult> {
  const result = await MetaDataLoader.fromDirectory(dir, opts);
  const json = canonicalSerialize(result.root);
  return {
    json,
    errors: result.errors,
    // FR5a: LoadResult.warnings is now LoaderWarning[]; ExportResult preserves
    // its public string[] shape (callers print warnings as text). Extract the
    // message for back-compat.
    warnings: result.warnings.map((w) => w.message),
  };
}
