import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import {
  Loader,
  TypeRegistry,
  registerCoreTypes,
  type MetaModel,
} from "@metaobjects/metadata";
import { registerForgeTypes } from "./forge-types.js";
import { discoverWorkspace, resolveExtendsOrder } from "./workspace.js";

/**
 * Default directory name (relative to project root) where metadata JSON files
 * are scanned. Scaffold via `forge init`; the directory is committed to git.
 */
export const DEFAULT_METADATA_DIR = "metaobjects";

/**
 * Default directory name (relative to project root) for Meta Forge's own
 * runtime state: config.json, .gen-state/, package.meta.json, agent docs.
 * Scaffold via `forge init`; most contents are committed to git.
 */
export const DEFAULT_METAFORGE_DIR = ".metaforge";

/**
 * Load all metadata files from `<repoRoot>/metaobjects/` into a single
 * MetaModel. If `<repoRoot>/.meta/package.meta.json` declares `extends:` deps
 * and a workspace can be discovered (pnpm-workspace.yaml or package.json
 * workspaces), peer packages are loaded too in topological dep-first order.
 *
 * Excludes `_pending/`. Registers metaobjects core types plus Meta Forge's
 * descriptive top-level types (decision, principle, etc.) so mixed content
 * parses without warnings.
 *
 * Throws if `metaobjects/` doesn't exist (callers should run `forge init`).
 *
 * @param repoRoot The project's working-directory root (e.g. process.cwd()).
 *   `loadMemory` resolves `metaobjects/` and (if workspace-aware) the
 *   transitive `extends:` graph automatically.
 */
export async function loadMemory(repoRoot: string): Promise<MetaModel> {
  const registry = new TypeRegistry();
  registerCoreTypes(registry);
  registerForgeTypes(registry);

  // Collect all metadata file paths to load. Order matters for the parser's
  // deferred-resolution pass (it parses in array order, then resolves supers
  // against the merged tree afterwards) — dep packages first, current last.
  const paths = await collectMetadataPaths(repoRoot);

  const loader = new Loader({ registry });
  const result = await loader.load(paths);

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
        paths.push(...(await listJsonFiles(join(pkgRoot, DEFAULT_METADATA_DIR))));
      }
      return paths;
    }
  }

  // Single-package path: scan metaobjects/ at the project root
  return listJsonFiles(join(repoRoot, DEFAULT_METADATA_DIR));
}

/**
 * Recursively list *.json files under a directory, excluding _pending/ at
 * any level. Subdirectories (e.g. projections/) are walked depth-first.
 * Files within a directory are sorted alphabetically for deterministic load
 * order; subdirectories are visited after files at the same level.
 */
async function listJsonFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    throw new Error(`loadMemory: cannot read ${dir}: ${(err as Error).message}`);
  }
  const paths: string[] = [];
  const subdirs: string[] = [];
  for (const entry of entries) {
    if (entry === "_pending") continue;
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) {
      subdirs.push(full);
    } else if (s.isFile() && entry.endsWith(".json")) {
      paths.push(full);
    }
  }
  // Recurse into subdirectories after collecting files at this level
  for (const sub of subdirs.sort()) {
    paths.push(...(await listJsonFiles(sub)));
  }
  return paths;
}
