// server/typescript/packages/sdk/src/discovery.ts
//
// Phase-1 metadata-source-resolution — nearest-ancestor config discovery.
//
// Walks up from a starting directory to find the nearest `.metaobjects/`
// carrying `config.json`. This is what makes a CLI *contextual*: run it
// inside an app in a monorepo and it finds that app's config rather than the
// repo root's. Two properties are load-bearing: nearest wins (a config in a
// subdirectory beats one in an ancestor — the walk returns on the FIRST
// directory found), and the walk stops at a repository boundary (`.git`), so
// a monorepo checkout can never silently adopt a *parent checkout's*
// configuration. The config check runs BEFORE the `.git` check within each
// directory — reversed, a config at the repo root (where `.git` also lives)
// would be unreachable from any subdirectory, since the boundary would stop
// the walk one directory too early.
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_METAOBJECTS_DIR } from "./memory.js";

const CONFIG_FILE = "config.json";
const GIT_DIR = ".git";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk up from `startDir` for the nearest directory holding
 * `.metaobjects/config.json`. The walk stops after examining a directory
 * that contains `.git`, so a monorepo can never silently adopt a parent
 * checkout's configuration. Returns the containing directory (not the
 * `.metaobjects` directory itself), or undefined when nothing is found.
 */
export async function findConfigDir(startDir: string): Promise<string | undefined> {
  let dir = resolve(startDir);
  for (;;) {
    if (await exists(join(dir, DEFAULT_METAOBJECTS_DIR, CONFIG_FILE))) return dir;
    // Boundary check AFTER the config check: a repo-root config (sharing its
    // directory with `.git`) is still findable from any subdirectory.
    if (await exists(join(dir, GIT_DIR))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
