import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import {
  composeRegistry,
  coreProviders,
  MetaDataLoader,
  type MetaDataTypeProvider,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { forgeTypesProvider } from "./forge-types.js";
import { discoverWorkspace, resolveExtendsOrder } from "./workspace.js";

/**
 * Default directory name (relative to project root) where metadata JSON files
 * are scanned. Scaffold via `meta init`; the directory is committed to git.
 */
export const DEFAULT_METADATA_DIR = "metaobjects";

/**
 * Default directory name (relative to project root) for MetaObjects' own
 * runtime state: config.json, .gen-state/, package.meta.json, agent docs.
 * Scaffold via `meta init`; most contents are committed to git.
 */
export const DEFAULT_METAOBJECTS_DIR = ".metaobjects";

/**
 * Options for {@link loadMemory}. Consumers can supply additional
 * {@link MetaDataTypeProvider}s to extend the metamodel with their own
 * subtypes/attrs (e.g. a `template.toolcall` subtype).
 */
export interface LoadMemoryOptions {
  /**
   * Consumer-supplied providers. Composed AFTER the default core providers
   * (core-types + db + documentation + forge) unless `replaceDefaults: true`
   * is set. Use this to register additional subtypes or extend existing
   * ones without forking the loader.
   */
  providers?: readonly MetaDataTypeProvider[];
  /**
   * Skip the default core providers; supply your own full set. Advanced —
   * use only when you need to compose a custom metamodel from scratch.
   * Throws if `providers` is absent or empty.
   */
  replaceDefaults?: boolean;
  /**
   * ADR-0023 strict-attr load. When `true`, an authored own `@-attr` matching
   * no registered per-type schema and no commonAttr is `ERR_UNKNOWN_ATTR`.
   * Defaults `false` (legacy open-attr policy) so a downstream app loads lax;
   * the `meta verify` command opts in to `true` (strict-by-default, #96).
   */
  strict?: boolean;
}

/** Default provider bundle threaded by {@link loadMemory} when no options
 *  override is supplied. Exposed for tests/inspection; callers shouldn't need
 *  to spread this manually — `loadMemory(root, { providers: [mine] })`
 *  composes `[...defaultLoadMemoryProviders, mine]` automatically. */
export const defaultLoadMemoryProviders: readonly MetaDataTypeProvider[] = [
  ...coreProviders,
  forgeTypesProvider,
];

/**
 * Load all metadata files from `<repoRoot>/metaobjects/` into a single
 * MetaData. If `<repoRoot>/.meta/package.meta.json` declares `extends:` deps
 * and a workspace can be discovered (pnpm-workspace.yaml or package.json
 * workspaces), peer packages are loaded too in topological dep-first order.
 *
 * Excludes `_pending/`. Registers metaobjects core types plus Meta Forge's
 * descriptive top-level types (decision, principle, etc.) so mixed content
 * parses without warnings. Consumer-supplied providers (via
 * {@link LoadMemoryOptions.providers}) are composed AFTER the defaults so
 * they may depend on core/forge ids.
 *
 * Throws if `metaobjects/` doesn't exist (callers should run `meta init`).
 *
 * @param repoRoot The project's working-directory root (e.g. process.cwd()).
 *   `loadMemory` resolves `metaobjects/` and (if workspace-aware) the
 *   transitive `extends:` graph automatically.
 * @param options Optional {@link LoadMemoryOptions} — supply additional
 *   providers or replace the default bundle entirely.
 */
export async function loadMemory(
  repoRoot: string,
  options?: LoadMemoryOptions,
): Promise<MetaRoot> {
  const extra = options?.providers ?? [];
  let providers: readonly MetaDataTypeProvider[];
  if (options?.replaceDefaults === true) {
    if (extra.length === 0) {
      throw new Error(
        "loadMemory: `replaceDefaults: true` requires at least one provider in `providers`.",
      );
    }
    providers = extra;
  } else {
    providers = [...defaultLoadMemoryProviders, ...extra];
  }
  const registry = composeRegistry(providers);

  // Collect all metadata file paths to load. Order matters for the parser's
  // deferred-resolution pass (it parses in array order, then resolves supers
  // against the merged tree afterwards) — dep packages first, current last.
  const paths = await collectMetadataPaths(repoRoot);

  const loader = new MetaDataLoader({
    registry,
    ...(options?.strict === true ? { strict: true } : {}),
  });
  const result = await loader.load(paths.map((p) => new FileSource(p)));

  if (result.errors.length > 0) {
    const first = result.errors[0]!;
    throw first;
  }

  return result.root;
}

// Dep packages' metaobjects/ files first (topological order), then current.
async function collectMetadataPaths(repoRoot: string): Promise<string[]> {
  const currentMetaDir = join(repoRoot, ".meta");
  const ws = await discoverWorkspace(repoRoot);

  // Workspace path: walk extends, load dep metaobjects/ dirs first
  if (ws !== undefined) {
    const currentPkg = ws.packages.find((p) => p.metaDir === currentMetaDir);
    if (currentPkg !== undefined && currentPkg.manifest.extends.length > 0) {
      const ordered = resolveExtendsOrder(ws, currentMetaDir);
      const paths: string[] = [];
      for (const pkg of ordered) {
        // Each workspace package's metadata lives alongside its .meta/ dir
        const pkgRoot = join(pkg.metaDir, "..");
        paths.push(...(await listMetadataFiles(join(pkgRoot, DEFAULT_METADATA_DIR))));
      }
      return paths;
    }
  }

  // Single-package path: scan metaobjects/ at the project root
  return listMetadataFiles(join(repoRoot, DEFAULT_METADATA_DIR));
}

/**
 * Recursively list metadata files (*.json, *.yaml, *.yml) under a directory,
 * excluding _pending/ at any level. Subdirectories (e.g. projections/) are
 * walked depth-first. Files within a directory are sorted alphabetically for
 * deterministic load order; subdirectories are visited after files at the
 * same level.
 *
 * Format selection (parsing) happens downstream in `FileSource` from
 * `@metaobjectsdev/metadata`, which infers the parser from file extension.
 */
async function listMetadataFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    throw new Error(`loadMemory: cannot read ${dir}: ${(err as Error).message}`);
  }
  const paths: string[] = [];
  const subdirs: string[] = [];
  // #188: sort the raw `readdir` entries so file order is deterministic across
  // runtimes/filesystems (Node vs Bun return different `readdir` orders), matching
  // this function's docstring and the metadata package's own `DirectorySource`.
  // (Resolution is now order-INDEPENDENT — super-resolve.ts #188 — so this is the
  // deterministic-enumeration FLOOR, not the fix; it keeps every derived artifact
  // that preserves declaration order, e.g. serialization, stable across runtimes.)
  for (const entry of [...entries].sort()) {
    if (entry === "_pending") continue;
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) {
      subdirs.push(full);
    } else if (s.isFile() && isMetadataFile(entry)) {
      paths.push(full);
    }
  }
  // Recurse into subdirectories after collecting files at this level
  for (const sub of subdirs.sort()) {
    paths.push(...(await listMetadataFiles(sub)));
  }
  return paths;
}

function isMetadataFile(name: string): boolean {
  return name.endsWith(".json") || name.endsWith(".yaml") || name.endsWith(".yml");
}
