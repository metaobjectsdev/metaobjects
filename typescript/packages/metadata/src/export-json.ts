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
//     whatever tree the Loader returned (Loader always returns a valid MetaModel).
//   - I/O failures (missing/unreadable directory) are caught by
//     `loadFromDirectory` and returned in its `errors[]`; `loadAndExportJson`
//     surfaces them unchanged in `ExportResult.errors`. It does not throw for
//     directory or metadata problems.

import { Loader } from "./loader.js";
import type { LoadOptions } from "./loader.js";
import { canonicalSerialize } from "./serializer-json.js";

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
 * Internally constructs a fresh `Loader` (using the default registry seeded
 * via `registerCoreTypes()`), calls `loadFromDirectory`, then serializes the
 * resulting tree with `canonicalSerialize`.
 *
 * @param dir  Absolute or relative path to the directory containing `meta.*.json` files.
 * @param opts Optional loader options forwarded to the `Loader` constructor
 *             (registry, freeze, strict). The `exclude` glob list can be
 *             supplied as `opts.exclude` — see `Loader.loadFromDirectory`.
 */
export async function loadAndExportJson(
  dir: string,
  opts?: LoadOptions & { exclude?: string[] },
): Promise<ExportResult> {
  const { exclude, ...loaderOpts } = opts ?? {};
  const loader = new Loader(loaderOpts);
  // Only pass the exclude option when defined, to satisfy exactOptionalPropertyTypes.
  const dirOpts = exclude !== undefined ? { exclude } : undefined;
  const result = await loader.loadFromDirectory(dir, dirOpts);
  const json = canonicalSerialize(result.root);
  return {
    json,
    errors: result.errors,
    warnings: result.warnings,
  };
}
