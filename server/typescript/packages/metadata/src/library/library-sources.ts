// library-sources.ts — resolves MetaDataSource instances for shipped library packages.
//
// On-disk-first: if the repo-root library/ tree is reachable (dev / installed-from-source
// layout), a FileSource is returned so edits to the on-disk YAML are picked up immediately.
// Embedded fallback: when the binary is compiled (bun --compile) or the library/ directory
// is absent, the content embedded in embedded-library.generated.ts is used.

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FileSource } from "../loader/sources/file-source.js";
import { InMemoryStringSource } from "../loader/meta-data-source.js";
import type { MetaDataSource } from "../loader/meta-data-source.js";
import { EMBEDDED_LIBRARY } from "./embedded-library.generated.js";

// Package → ordered refs, derived from the generated embedded module so adding a
// library file (which regenerates EMBEDDED_LIBRARY) needs no edit here.
const REFS_BY_PACKAGE: Readonly<Record<string, readonly string[]>> = (() => {
  const map: Record<string, string[]> = {};
  for (const ref of Object.keys(EMBEDDED_LIBRARY).sort()) {
    const pkg = ref.split("/")[0];
    if (pkg === undefined || pkg === "") continue;
    (map[pkg] ??= []).push(ref);
  }
  return map;
})();

/**
 * Locate the repo-root `library/` directory by walking up from this module's
 * location until a directory contains BOTH `library/` and `server/` (the two
 * structural anchors that identify the repo root). Returns the path to the
 * `library/` subdirectory if found, or `undefined` when absent (compiled binary).
 */
function libraryDirOnDisk(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "library")) && existsSync(join(dir, "server"))) {
      return join(dir, "library");
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return undefined;
}

// Cache the on-disk location: resolved once per process.
let _cache: { dir: string | undefined } | undefined;

function getLibraryDir(): string | undefined {
  return (_cache ??= { dir: libraryDirOnDisk() }).dir;
}

/**
 * The library package names this build ships, sorted.
 *
 * `librarySources` skips an unrecognised package silently — the right behaviour for a
 * programmatic caller asking for something a given version may not ship. A name a human
 * typed into a config file is a different case: skipping it silently resurfaces later as
 * `ERR_UNRESOLVED_SUPER` pointing at the adopter's own metadata, which is the wrong place
 * to go looking. Config readers use this to refuse an unknown name and say what IS
 * available (Python's `project_config` draws the same line, in the same place).
 */
export function knownLibraryPackages(): string[] {
  return Object.keys(REFS_BY_PACKAGE).sort();
}

/**
 * Returns a list of `MetaDataSource` instances for the requested library packages.
 *
 * - Recognized packages: `"ai"` (others contribute no sources).
 * - Per ref: if the on-disk `library/<ref>.yaml` exists, returns a `FileSource`;
 *   otherwise falls back to an `InMemoryStringSource` built from the embedded content.
 *
 * @param packages - Package names to include (e.g. `["ai"]`).
 */
export function librarySources(packages: string[]): MetaDataSource[] {
  const dir = getLibraryDir();
  const out: MetaDataSource[] = [];

  for (const pkg of packages) {
    const refs = REFS_BY_PACKAGE[pkg];
    if (refs === undefined) continue; // unknown package — no sources

    for (const ref of refs) {
      if (dir !== undefined) {
        const path = join(dir, `${ref}.yaml`);
        if (existsSync(path)) {
          out.push(new FileSource(path));
          continue;
        }
      }
      const embedded = EMBEDDED_LIBRARY[ref];
      if (embedded !== undefined) {
        out.push(
          new InMemoryStringSource(embedded, {
            id: `library:${ref}.yaml`,
            format: "yaml",
          }),
        );
      } else {
        throw new Error(
          `library ref "${ref}" (package "${pkg}") has no on-disk file and no embedded entry — ` +
            `the embedded library module is stale; run scripts/generate-embedded-library.ts`,
        );
      }
    }
  }

  return out;
}
