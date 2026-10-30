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

import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve, basename, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
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

/** @deprecated The v0.3 `package.meta.json` prototype: nothing in the toolchain reads it. Cross-repo metadata sharing is FR-023 (metadata dependencies). Removed in 2.0. */
export interface WorkspacePackage {
  /** Absolute path to the .meta/ directory. */
  metaDir: string;
  /** The parsed package.meta.json. */
  manifest: PackageManifest;
  /** The canonical metaobjects ref (resolved via resolveMetaobjectsPackage). */
  metaobjectsPackage: string;
}

/** @deprecated The v0.3 `package.meta.json` prototype: nothing in the toolchain reads it. Cross-repo metadata sharing is FR-023 (metadata dependencies). Removed in 2.0. */
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
 * Extract the `packages:` glob list from pnpm-workspace.yaml with a real YAML parser, so
 * block lists at any indent, flow lists, quoting and `#` inside quoted patterns all behave
 * as pnpm reads them. Negations (`!apps/legacy`) are returned verbatim; `expandGlobs`
 * applies them. Invalid YAML or a non-list `packages` yields `[]`.
 */
export function extractPnpmPackages(yaml: string): string[] {
  let doc: unknown;
  try {
    doc = parseYaml(yaml);
  } catch {
    return [];
  }
  if (typeof doc !== "object" || doc === null) return [];
  const packages = (doc as { packages?: unknown }).packages;
  if (!Array.isArray(packages)) return [];
  return packages.filter((p): p is string => typeof p === "string");
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
// Glob expansion (workspace-style patterns: `*`, `?`, `**`, leading `!` negation)
// ---------------------------------------------------------------------------

/** Directories pnpm's workspace walk never enters, whatever the pattern says. */
const WORKSPACE_IGNORED_DIRS = new Set(["node_modules", "bower_components", "test", "tests"]);

/** Split a pattern into path segments, dropping `./` prefixes and trailing slashes. */
function patternSegments(glob: string): string[] {
  return glob.split("/").filter((seg) => seg !== "" && seg !== ".");
}

/** One path segment against one pattern segment (`*` = any run, `?` = one char; no `/`). */
function matchGlobSegment(pattern: string): (value: string) => boolean {
  if (pattern === "*") return () => true;
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]") +
      "$",
  );
  return (value) => regex.test(value);
}

/** Does the whole path match the whole pattern? `**` spans zero or more segments. */
function matchSegments(pattern: readonly string[], path: readonly string[]): boolean {
  const [head, ...rest] = pattern;
  if (head === undefined) return path.length === 0;
  if (head === "**") {
    for (let skip = 0; skip <= path.length; skip++) {
      if (matchSegments(rest, path.slice(skip))) return true;
    }
    return false;
  }
  const [first, ...remaining] = path;
  return first !== undefined && matchGlobSegment(head)(first) && matchSegments(rest, remaining);
}

async function subdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => !WORKSPACE_IGNORED_DIRS.has(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether a wildcard segment may match `name`: as in pnpm (micromatch without `dot`), a
 *  wildcard matches a dot-directory only when the segment itself starts with a dot. */
function wildcardMay(name: string, segment: string): boolean {
  return !name.startsWith(".") || segment.startsWith(".");
}

/**
 * `**` expansion: zero or more directory levels, the base included. Symlinks are followed
 * but each real directory is visited once (cycle guard); dot-directories are not descended
 * into.
 */
async function expandGlobstar(
  dir: string,
  rest: readonly string[],
  visited: Set<string>,
): Promise<string[]> {
  let real: string;
  try {
    real = await realpath(dir);
  } catch {
    return [];
  }
  if (visited.has(real)) return [];
  visited.add(real);
  const found = await expandSegments(dir, rest);
  for (const name of await subdirectories(dir)) {
    if (!wildcardMay(name, "**")) continue;
    const child = join(dir, name);
    if (!(await isDirectory(child))) continue;
    found.push(...(await expandGlobstar(child, rest, visited)));
  }
  return found;
}

/** Directories under `dir` matching the remaining pattern segments. */
async function expandSegments(dir: string, segments: readonly string[]): Promise<string[]> {
  const [head, ...rest] = segments;
  if (head === undefined) return [dir];
  if (head === "**") {
    return expandGlobstar(dir, rest, new Set());
  }
  if (!/[*?]/.test(head)) {
    if (WORKSPACE_IGNORED_DIRS.has(head)) return [];
    const child = join(dir, head);
    return (await isDirectory(child)) ? expandSegments(child, rest) : [];
  }
  const matcher = matchGlobSegment(head);
  const found: string[] = [];
  for (const name of await subdirectories(dir)) {
    const child = join(dir, name);
    if (wildcardMay(name, head) && matcher(name) && (await isDirectory(child))) found.push(...(await expandSegments(child, rest)));
  }
  return found;
}

/**
 * Expand workspace globs relative to `root`: every positive pattern contributes its
 * matching directories, then every `!`-negated pattern removes the ones it matches.
 */
async function expandGlobs(root: string, globs: readonly string[]): Promise<string[]> {
  const negations = globs
    .filter((g) => g.startsWith("!"))
    .map((g) => patternSegments(g.slice(1)));
  const found = new Set<string>();
  for (const glob of globs) {
    if (glob.startsWith("!")) continue;
    for (const dir of await expandSegments(root, patternSegments(glob))) found.add(dir);
  }
  return [...found].filter((dir) => {
    const rel = relative(root, dir).split(sep);
    return !negations.some((neg) => matchSegments(neg, rel));
  });
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
 *
 * @deprecated The v0.3 `package.meta.json` prototype: nothing in the toolchain reads it. Cross-repo metadata sharing is FR-023 (metadata dependencies). Removed in 2.0.
 */
export async function discoverWorkspace(cwd: string): Promise<Workspace | undefined> {
  const config = await findWorkspaceConfig(cwd);
  if (config === undefined) return undefined;

  // Expand all workspace globs
  const packageDirs = await expandGlobs(config.root, config.globs);

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
 *
 * @deprecated The v0.3 `package.meta.json` prototype: nothing in the toolchain reads it. Cross-repo metadata sharing is FR-023 (metadata dependencies). Removed in 2.0.
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

/**
 * Human-readable label for a workspace package — useful for error messages.
 *
 * @deprecated The v0.3 `package.meta.json` prototype: nothing in the toolchain reads it. Cross-repo metadata sharing is FR-023 (metadata dependencies). Removed in 2.0.
 */
export function packageLabel(pkg: WorkspacePackage): string {
  return `${pkg.manifest.name} (${pkg.metaobjectsPackage}) at ${basename(dirname(pkg.metaDir))}`;
}
