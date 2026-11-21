// Test helpers for the per-package hash manifest (`.gen-state/.hashes/<package>.json`,
// ADR-0064 Amendment 1). Tests read the manifest through these instead of one file.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HASHES_DIR,
  LEGACY_HASHES_FILE,
  manifestExists,
  readManifestState,
} from "../../src/hash-manifest-store.js";
import { removeTree } from "../../src/scratch-dir.js";

export { HASHES_DIR, LEGACY_HASHES_FILE, manifestExists };

/** Every recorded entry: the union of all manifest files (and a legacy file, if present). */
export function manifestEntries(genStateDir: string): Record<string, any> {
  return readManifestState(genStateDir).entries as Record<string, any>;
}

/** File name -> text of every file in `.hashes/`. */
export function manifestFiles(genStateDir: string): Record<string, string> {
  const dir = join(genStateDir, HASHES_DIR);
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) out[name] = readFileSync(join(dir, name), "utf-8");
  return out;
}

/** File name -> mtime (ms) of every file in `.hashes/`. */
export function manifestMtimes(genStateDir: string): Record<string, number> {
  const dir = join(genStateDir, HASHES_DIR);
  const out: Record<string, number> = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) out[name] = statSync(join(dir, name)).mtimeMs;
  return out;
}

/** Remove the whole manifest (per-package dir and legacy file). */
export function removeManifest(genStateDir: string): void {
  removeTree(join(genStateDir, HASHES_DIR));
  rmSync(join(genStateDir, LEGACY_HASHES_FILE), { force: true });
}

/** Write the OLD single-file layout, as a pre-amendment checkout would have it. */
export function seedLegacyManifest(genStateDir: string, entries: Record<string, unknown>): void {
  mkdirSync(genStateDir, { recursive: true });
  writeFileSync(join(genStateDir, LEGACY_HASHES_FILE), JSON.stringify(entries, null, 2) + "\n");
}

/** True for paths of a file inside `.hashes/`. */
export const isManifestPath = (p: unknown): boolean => String(p).includes(`/${HASHES_DIR}/`);

/** Replace one recorded entry in place, in whichever manifest file holds it. */
export function setManifestEntry(genStateDir: string, path: string, entry: unknown): void {
  const state = readManifestState(genStateDir);
  const name = state.fileOf.get(path);
  if (name === undefined) throw new Error(`no manifest file records ${path}`);
  const file = join(genStateDir, HASHES_DIR, name);
  const entries = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  entries[path] = entry;
  writeFileSync(file, JSON.stringify(entries, null, 2) + "\n");
}
