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

/** Map of package name → ordered list of YAML refs (path under library/ minus .yaml). */
const REFS_BY_PACKAGE: Readonly<Record<string, readonly string[]>> = {
  ai: ["ai/llm-call"],
} as const;

/**
 * Locate the repo-root `library/` directory by walking up from this module's
 * location until `library/ai/llm-call.yaml` is found (the sentinel file).
 * Returns the path to `library/` if found, or `undefined` when absent (compiled binary).
 */
function libraryDirOnDisk(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, "library");
    if (existsSync(join(candidate, "ai"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return undefined;
}

// Cache the on-disk location: it is resolved once per process.
let _resolvedDir: string | undefined | null = null; // null = not yet resolved

function getLibraryDir(): string | undefined {
  if (_resolvedDir === null) {
    _resolvedDir = libraryDirOnDisk();
  }
  return _resolvedDir ?? undefined;
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
