// server/typescript/packages/sdk/src/discovery.ts
//
// Phase-1 metadata-source-resolution — nearest-ancestor collection discovery.
//
// Walks up from a starting directory to find the nearest directory that IS a
// project root. This is what makes a CLI *contextual*: run it inside an app in
// a monorepo and it finds that app's configuration rather than the repo root's.
//
// Three properties are load-bearing.
//
// 1. **Two markers, not one.** A directory is a project root when it carries
//    `.metaobjects/config.json` OR a `metaobjects/` directory. The config half
//    is the declared form; the `metaobjects/` half is the pre-source-resolution
//    convention, and skipping past it would silently load an ANCESTOR's model
//    (and write generated output to the ancestor's `outDir`) for a nested
//    project that has always read its own — a back-compat regression on a
//    layout that worked. The config is checked first so a directory carrying
//    both resolves as declared. See design §4.6.1.
// 2. **Nearest wins** — the walk returns on the FIRST directory carrying either
//    marker, so a config in a subdirectory beats one in an ancestor.
// 3. **The walk stops at a repository boundary** (`.git`), so a monorepo
//    checkout can never silently adopt a *parent checkout's* configuration. The
//    marker checks run BEFORE the `.git` check within each directory —
//    reversed, a root-level project (where `.git` also lives) would be
//    unreachable from any subdirectory, since the boundary would stop the walk
//    one directory too early.
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CONFIG_FILE } from "./config.js";
import { DEFAULT_METADATA_DIR, DEFAULT_METAOBJECTS_DIR } from "./memory.js";

const GIT_DIR = ".git";

/** Exported for reuse — `collection.ts` had its own byte-identical copy
 *  (`fileExists`); one definition, imported. */
export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** `exists`, narrowed to directories. A plain FILE named `metaobjects` is not a
 *  metadata home, so it must not stop the walk below — and `collection.ts`'s
 *  default-directory probe needs the same distinction to raise its friendlier
 *  `ERR_COLLECTION_NOT_FOUND`. */
export async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Where the discovery walk stopped, and what it found there. */
export interface DiscoveredRoot {
  /** The project root the walk settled on. Always absolute; falls back to the
   *  resolved start directory when the walk found no marker at all. */
  readonly dir: string;
  /** Whether `dir` carries `.metaobjects/config.json`. False both for a
   *  `metaobjects/`-only directory and for the no-marker fallback — in either
   *  case the DEFAULT sources apply, which is the pre-branch behaviour. */
  readonly hasConfig: boolean;
}

/**
 * Walk up from `startDir` for the nearest project root — a directory holding
 * `.metaobjects/config.json` or a `metaobjects/` directory (see the file
 * header for why both count). The walk stops after examining a directory that
 * contains `.git`, so a monorepo can never silently adopt a parent checkout's
 * configuration.
 *
 * Never fails: with no marker anywhere below the boundary it reports the
 * resolved `startDir` with `hasConfig: false`, which is what
 * `resolveCollection` turns into either the default `metaobjects/` source or
 * `ERR_COLLECTION_NOT_FOUND`.
 */
export async function discoverCollectionRoot(startDir: string): Promise<DiscoveredRoot> {
  const start = resolve(startDir);
  let dir = start;
  for (;;) {
    if (await exists(join(dir, DEFAULT_METAOBJECTS_DIR, CONFIG_FILE))) {
      return { dir, hasConfig: true };
    }
    if (await isDir(join(dir, DEFAULT_METADATA_DIR))) return { dir, hasConfig: false };
    // Boundary check AFTER the marker checks: a repo-root project (sharing its
    // directory with `.git`) is still findable from any subdirectory.
    if (await exists(join(dir, GIT_DIR))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { dir: start, hasConfig: false };
}

/**
 * The directory whose configuration governs a run started in `startDir` — the
 * `dir` half of {@link discoverCollectionRoot}.
 *
 * Exists as its own export for the callers that must NOT require metadata to
 * exist: `meta migrate apply-pending` and `--rollback` replay committed SQL and
 * load no model at all, so they resolve their `.metaobjects/` directory through
 * this rather than through `resolveCollection`. Sharing the walk is the point —
 * a second "find the project root" implementation is how the migrations
 * directory and the metadata directory come to disagree.
 */
export async function resolveConfigDir(startDir: string): Promise<string> {
  return (await discoverCollectionRoot(startDir)).dir;
}
