// server/typescript/packages/sdk/src/metadata-files.ts
//
// The project's default directory names, what counts as a metadata file, and
// the one walk that turns a directory into an ordered file list.
//
// **This module imports nothing from its siblings, and that is the point.**
// `resolveCollection` (`collection.ts`) is the single authority on where
// metadata lives, so `memory.ts`'s `loadMemory` must call it — while
// `collection.ts` and `sources.ts` need the constants and the walk below.
// Homing those in `memory.ts` closes an ESM cycle whose failure mode is not a
// warning but a crash: `DEFAULT_SOURCES` (`sources.ts`) reads
// `DEFAULT_METADATA_DIR` at module top level, so the cycle surfaces as
// `ReferenceError: Cannot access 'DEFAULT_METADATA_DIR' before initialization`
// on whichever module the entry point happens to reach first. A leaf both
// sides import is the fix; a lazy `await import()` inside `loadMemory` is not
// — that hides the cycle rather than removing it.
import { extname, join } from "node:path";
import { readdir, stat } from "node:fs/promises";

/**
 * The DEFAULT value of `sources` — the directory scanned when
 * `.metaobjects/config.json` declares no sources. Scaffold via `meta init`;
 * the directory is committed to git.
 *
 * **A default, and nothing else.** No read path may assume a directory of this
 * name exists or is where metadata lives: that question is answered by
 * `resolveCollection`, which applies this constant exactly once (via
 * `DEFAULT_SOURCES` in `sources.ts`) when a project declares nothing. A
 * project that declares `sources` may put its metadata anywhere, and every
 * command follows the config. `test/no-hardcoded-metadata-dir.test.ts` is the
 * enforcer.
 */
export const DEFAULT_METADATA_DIR = "metaobjects";

/**
 * Default directory name (relative to project root) for MetaObjects' own
 * runtime state: config.json, .gen-state/, package.meta.json, agent docs.
 * Scaffold via `meta init`; most contents are committed to git.
 *
 * Unlike {@link DEFAULT_METADATA_DIR} this one IS a fixed convention — it is
 * where the config that answers "where is the metadata?" lives, so it cannot
 * itself be configured.
 */
export const DEFAULT_METAOBJECTS_DIR = ".metaobjects";

/** Recognized metadata file extensions, matched case-insensitively — mirrors
 *  `DirectorySource` in `@metaobjectsdev/metadata`, which checks
 *  `extname().toLowerCase()`. The single definition every metadata-file
 *  walker in this package uses — and since `resolveSources` (`sources.ts`)
 *  calls {@link listMetadataFiles} outright rather than keeping a second
 *  recursive walk of its own, there is exactly one walker to keep honest. */
export const METADATA_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);

export function isMetadataFile(name: string): boolean {
  return METADATA_EXTENSIONS.has(extname(name).toLowerCase());
}

/** Directory excluded at every level of {@link listMetadataFiles} — drafts
 *  that are deliberately not part of the loaded model. */
const PENDING_DIR = "_pending";

/**
 * Recursively list metadata files (*.json, *.yaml, *.yml, matched
 * case-insensitively — see `isMetadataFile` above) under a directory,
 * excluding _pending/ at any level. Subdirectories (e.g. projections/) are
 * walked depth-first. Files within a directory are sorted alphabetically for
 * deterministic load order; subdirectories are visited AFTER the files at the
 * same level.
 *
 * That per-level rule is a contract, not an implementation detail. This is the
 * order production has always handed the loader, and declaration order survives
 * into generated output: `codegen-ts`'s barrel emits from `root.objects()`
 * order, and so do the shared `enums.ts`, `meta docs` page ordering and `meta
 * export`'s `canonicalSerialize` sibling order. A flat lexicographic sort of
 * absolute paths is NOT the same list — it disagrees whenever a subdirectory
 * name sorts before a sibling file (`common/` before `meta.users.json`) — so
 * `resolveSources` calls this function rather than re-walking and re-sorting.
 * Pinned by `test/source-order.test.ts`.
 *
 * Exported for that gate and for `sources.ts`; not re-exported from the package
 * index — `resolveCollection` is the public door.
 *
 * An entry whose `stat` fails (a dangling symlink, a TOCTOU removal between
 * `readdir` and `stat`, an EACCES entry) is SKIPPED, matching `DirectorySource`
 * in `@metaobjectsdev/metadata`, which this walk otherwise mirrors. A failure to
 * read the directory itself still throws — that is the "you have no metadata
 * here" case callers report.
 *
 * Format selection (parsing) happens downstream in `FileSource` from
 * `@metaobjectsdev/metadata`, which infers the parser from file extension.
 */
export async function listMetadataFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    throw new Error(`cannot read metadata directory ${dir}: ${(err as Error).message}`);
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
    if (entry === PENDING_DIR) continue;
    const full = join(dir, entry);
    // `stat` (not `lstat`/`Dirent.isDirectory()`) so a symlinked subdirectory is
    // traversed — `DirectorySource` has always followed symlinks this way.
    const s = await stat(full).catch(() => undefined);
    if (s === undefined) continue;
    if (s.isDirectory()) {
      subdirs.push(full);
    } else if (s.isFile() && isMetadataFile(entry)) {
      paths.push(full);
    }
  }
  // Recurse into subdirectories after collecting files at this level.
  // `subdirs` is already in sorted order (built from the sorted `entries` above).
  for (const sub of subdirs) {
    paths.push(...(await listMetadataFiles(sub)));
  }
  return paths;
}
