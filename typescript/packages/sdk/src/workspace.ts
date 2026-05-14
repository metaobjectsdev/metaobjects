// Workspace discovery — finds peer metadata packages in a monorepo via the
// workspace conventions used by pnpm/npm/bun. The result is a registry of
// `package.meta.json` files keyed by their `name` and `metaobjectsPackage`,
// used by loadMemory (when extends: is present) and by future cross-package
// codegen/migrate flows.
//
// Discovery sources (first match wins, walking up from cwd):
//   - pnpm-workspace.yaml      (packages: array)
//   - package.json workspaces  (array of globs OR { packages: [...] })
//
// This is the prototype implementation. Full v0.3 SP2 will harden:
//   - Bun workspaces (currently mirrors package.json field)
//   - Cargo / Maven workspaces (future polyglot support)
//   - Lockfile-style resolution + version range matching
//   - Better error messages on circular extends, missing packages

import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve, basename } from "node:path";
import {
  type PackageManifest,
  PackageManifestSchema,
  PACKAGE_MANIFEST_FILE,
  resolveMetaobjectsPackage,
} from "./package.js";

const PNPM_WORKSPACE_FILE = "pnpm-workspace.yaml";
const PACKAGE_JSON = "package.json";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WorkspacePackage {
  /** Absolute path to the .meta/ directory. */
  metaDir: string;
  /** The parsed package.meta.json. */
  manifest: PackageManifest;
  /** The canonical metaobjects ref (resolved via resolveMetaobjectsPackage). */
  metaobjectsPackage: string;
}

export interface Workspace {
  /** Absolute path to the workspace root (where pnpm-workspace.yaml or package.json lives). */
  root: string;
  /** All metadata packages found under workspace globs. */
  packages: WorkspacePackage[];
  /** Look up by package.meta.json `name` (e.g., "@acme/shared"). */
  findByName(name: string): WorkspacePackage | undefined;
  /** Look up by canonical metaobjects ref (e.g., "acme::shared"). */
  findByMetaobjectsPackage(ref: string): WorkspacePackage | undefined;
}

// ---------------------------------------------------------------------------
// Workspace root discovery
// ---------------------------------------------------------------------------

interface WorkspaceConfig {
  root: string;
  /** Workspace globs (e.g., "packages/*"). */
  globs: string[];
}

async function readPnpmWorkspaceFile(path: string): Promise<string[] | undefined> {
  try {
    const content = await readFile(path, "utf8");
    return extractPnpmPackages(content);
  } catch {
    return undefined;
  }
}

/**
 * Extract the `packages:` glob list from pnpm-workspace.yaml. Tiny parser —
 * sufficient for the simple-list format pnpm actually emits. Not a general
 * YAML parser; doesn't support quoted strings with special chars, flow
 * mappings, anchors, etc.
 */
export function extractPnpmPackages(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const result: string[] = [];
  let inPackages = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (line.length === 0) continue;
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const match = /^\s+-\s+['"]?([^'"]+)['"]?\s*$/.exec(line);
      if (match !== null) {
        result.push(match[1]!);
        continue;
      }
      // Non-list line at the same or lower indent ends the packages: block
      if (/^[A-Za-z_]/.test(line)) {
        inPackages = false;
      }
    }
  }
  return result;
}

async function readPackageJsonWorkspaces(path: string): Promise<string[] | undefined> {
  try {
    const content = await readFile(path, "utf8");
    const parsed = JSON.parse(content) as {
      workspaces?: string[] | { packages?: string[] };
    };
    if (Array.isArray(parsed.workspaces)) return parsed.workspaces;
    if (parsed.workspaces && Array.isArray(parsed.workspaces.packages)) {
      return parsed.workspaces.packages;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Walk up from `start` looking for the first directory with a workspace config. */
async function findWorkspaceConfig(start: string): Promise<WorkspaceConfig | undefined> {
  let dir = resolve(start);
  // Cap walk-up at filesystem root; in practice we'll find or stop in a few steps.
  while (true) {
    const pnpmPath = join(dir, PNPM_WORKSPACE_FILE);
    const pnpmGlobs = await readPnpmWorkspaceFile(pnpmPath);
    if (pnpmGlobs !== undefined && pnpmGlobs.length > 0) {
      return { root: dir, globs: pnpmGlobs };
    }

    const pkgPath = join(dir, PACKAGE_JSON);
    const pkgGlobs = await readPackageJsonWorkspaces(pkgPath);
    if (pkgGlobs !== undefined && pkgGlobs.length > 0) {
      return { root: dir, globs: pkgGlobs };
    }

    const parent = dirname(dir);
    if (parent === dir) return undefined; // hit filesystem root
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Glob expansion (simple, matches workspace-style patterns)
// ---------------------------------------------------------------------------

/** Expand a workspace glob like "packages/*" relative to root. Returns directory paths. */
async function expandGlob(root: string, glob: string): Promise<string[]> {
  // Strip trailing `/` for normalization
  const pattern = glob.replace(/\/$/, "");

  // No wildcard: literal directory
  if (!pattern.includes("*")) {
    const literal = join(root, pattern);
    try {
      const s = await stat(literal);
      return s.isDirectory() ? [literal] : [];
    } catch {
      return [];
    }
  }

  // Split into prefix segments (literal) + last segment with wildcard.
  // Supports the common cases: "packages/*", "apps/*", "packages/foo-*".
  // Doesn't support deep `**` globs in this prototype.
  const segments = pattern.split("/");
  const lastSegment = segments.pop()!;
  const prefixDir = join(root, ...segments);

  let entries: string[];
  try {
    entries = await readdir(prefixDir);
  } catch {
    return [];
  }

  const matcher = matchGlobSegment(lastSegment);
  const result: string[] = [];
  for (const entry of entries) {
    if (!matcher(entry)) continue;
    const full = join(prefixDir, entry);
    try {
      const s = await stat(full);
      if (s.isDirectory()) result.push(full);
    } catch {
      // skip unreadable
    }
  }
  return result;
}

function matchGlobSegment(pattern: string): (value: string) => boolean {
  if (pattern === "*") return () => true;
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*") +
      "$",
  );
  return (value) => regex.test(value);
}

// ---------------------------------------------------------------------------
// Public: discoverWorkspace
// ---------------------------------------------------------------------------

/**
 * Discover the metaobjects workspace containing `cwd`. Returns undefined if
 * no workspace config (pnpm-workspace.yaml or package.json workspaces) is
 * found walking up the directory tree, OR if no `.meta/package.meta.json`
 * files are present in the workspace packages.
 *
 * The returned Workspace has every package's manifest pre-loaded; callers
 * can look up peers by name or canonical metaobjects ref.
 */
export async function discoverWorkspace(cwd: string): Promise<Workspace | undefined> {
  const config = await findWorkspaceConfig(cwd);
  if (config === undefined) return undefined;

  // Expand all workspace globs
  const packageDirs: string[] = [];
  for (const glob of config.globs) {
    packageDirs.push(...(await expandGlob(config.root, glob)));
  }

  // Also include the workspace root itself if it has a .meta/ —
  // common pattern for root-level "the app" metadata.
  const rootMetaDir = join(config.root, ".meta");
  try {
    const s = await stat(rootMetaDir);
    if (s.isDirectory()) packageDirs.push(config.root);
  } catch {
    // no root-level .meta — fine
  }

  // For each package dir, look for .meta/package.meta.json
  const packages: WorkspacePackage[] = [];
  const seenDirs = new Set<string>();
  for (const pkgDir of packageDirs) {
    if (seenDirs.has(pkgDir)) continue;
    seenDirs.add(pkgDir);
    const metaDir = join(pkgDir, ".meta");
    try {
      const s = await stat(metaDir);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }
    const manifestPath = join(metaDir, PACKAGE_MANIFEST_FILE);
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf8");
    } catch {
      continue; // no manifest = not a metadata package
    }
    const manifest = PackageManifestSchema.parse(JSON.parse(raw));
    const canonical = resolveMetaobjectsPackage(manifest);
    if (canonical === undefined) {
      throw new Error(
        `package.meta.json in ${metaDir} has a name "${manifest.name}" that cannot be auto-derived to a canonical ref; declare metaobjectsPackage explicitly`,
      );
    }
    packages.push({ metaDir, manifest, metaobjectsPackage: canonical });
  }

  if (packages.length === 0) return undefined;

  return {
    root: config.root,
    packages,
    findByName(name: string) {
      return packages.find((p) => p.manifest.name === name);
    },
    findByMetaobjectsPackage(ref: string) {
      return packages.find((p) => p.metaobjectsPackage === ref);
    },
  };
}

// ---------------------------------------------------------------------------
// Resolve extends graph
// ---------------------------------------------------------------------------

/**
 * For a given package (specified by its .meta/ directory), walk its `extends:`
 * deps transitively via the workspace and return the full ordered list of
 * packages to load — dependencies first, the target package last.
 *
 * Throws on:
 *   - Missing package referenced by extends:
 *   - Cycles in the extends graph
 */
export function resolveExtendsOrder(
  workspace: Workspace,
  startMetaDir: string,
): WorkspacePackage[] {
  const startPkg = workspace.packages.find((p) => p.metaDir === startMetaDir);
  if (startPkg === undefined) {
    throw new Error(
      `metadata package at ${startMetaDir} is not part of the discovered workspace (root: ${workspace.root})`,
    );
  }

  const ordered: WorkspacePackage[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(pkg: WorkspacePackage): void {
    if (visited.has(pkg.metaobjectsPackage)) return;
    if (visiting.has(pkg.metaobjectsPackage)) {
      throw new Error(
        `cycle in extends graph: ${[...visiting, pkg.metaobjectsPackage].join(" → ")}`,
      );
    }
    visiting.add(pkg.metaobjectsPackage);
    for (const dep of pkg.manifest.extends) {
      const depPkg = workspace.findByName(dep) ?? workspace.findByMetaobjectsPackage(dep);
      if (depPkg === undefined) {
        throw new Error(
          `package "${pkg.manifest.name}" extends "${dep}" but that package was not found in the workspace`,
        );
      }
      visit(depPkg);
    }
    visiting.delete(pkg.metaobjectsPackage);
    visited.add(pkg.metaobjectsPackage);
    ordered.push(pkg);
  }

  visit(startPkg);
  return ordered;
}

// ---------------------------------------------------------------------------
// Diagnostic helpers
// ---------------------------------------------------------------------------

/** Human-readable label for a workspace package — useful for error messages. */
export function packageLabel(pkg: WorkspacePackage): string {
  return `${pkg.manifest.name} (${pkg.metaobjectsPackage}) at ${basename(dirname(pkg.metaDir))}`;
}
