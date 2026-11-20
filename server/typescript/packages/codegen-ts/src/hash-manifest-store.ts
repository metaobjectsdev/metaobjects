// The hash manifest as files on disk: one per model package (ADR-0064 Amendment 1).
//
// `.gen-state/.hashes.json` used to be one file for the whole project, so any two branches
// that regenerated anything both rewrote it and conflicted, whether or not they shared a
// generated file. The manifest is now `.gen-state/.hashes/<package>.json`, one file per
// model package, plus `.root.json` for a path in no package.
//
// This module reads the manifest and decides placement; `overwrite-policy.ts` writes it. The rest of codegen keeps seeing one flat map of
// path → entry (`overwrite-policy.ts` holds it in memory and every reader goes through it);
// what changes is where the bytes live. That is also why a wrong placement is harmless: a
// reader merges every file and finds a path wherever it is, so a misplaced entry costs a
// merge conflict that could have been avoided and nothing else.
//
// Placement is a pure function of the entry and the loaded model, so it is stable: an entry
// moves only when its object moves package or is renamed. See the ADR for the rule; the
// vectors every port runs are `fixtures/codegen-skip-conformance/manifests.json`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const LEGACY_HASHES_FILE = ".hashes.json";
export const HASHES_DIR = ".hashes";
export const ROOT_MANIFEST = ".root.json";

/** The metadata package separator. */
const PACKAGE_SEPARATOR = "::";

/** A loaded root-level object, as the stem rule needs it. `package` is `""` for none. */
export interface PlacementObject {
  name: string;
  package: string;
}

/** Everything the stem rule needs from the loaded model. Built once per run. */
export interface PlacementIndex {
  /** Each distinct object name as words, with the distinct packages that declare it. */
  readonly names: readonly { words: readonly string[]; packages: readonly string[] }[];
}

/**
 * Split a name or file stem into lowercase words: at `_` and `-`, before an uppercase letter
 * that follows a lowercase letter or digit, and before the last capital of a run that a
 * lowercase letter follows (`HTTPServer` is `http`, `server`). Digits stay with the word
 * before them. Only ASCII letters carry case.
 */
export function splitWords(text: string): string[] {
  const words: string[] = [];
  let word = "";
  const flush = (): void => {
    if (word !== "") words.push(word.toLowerCase());
    word = "";
  };
  const upper = (c: string | undefined): boolean => c !== undefined && c >= "A" && c <= "Z";
  const lower = (c: string | undefined): boolean => c !== undefined && ((c >= "a" && c <= "z") || (c >= "0" && c <= "9"));
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "_" || c === "-") {
      flush();
      continue;
    }
    if (upper(c) && word !== "") {
      const prev = text[i - 1];
      const next = text[i + 1];
      const nextLower = next !== undefined && next >= "a" && next <= "z";
      if (lower(prev) || (upper(prev) && nextLower)) flush();
    }
    word += c;
  }
  flush();
  return words;
}

export function buildPlacementIndex(objects: readonly PlacementObject[]): PlacementIndex {
  const byName = new Map<string, Set<string>>();
  for (const o of objects) {
    let set = byName.get(o.name);
    if (set === undefined) byName.set(o.name, (set = new Set()));
    set.add(o.package);
  }
  const names = [...byName.entries()].map(([name, packages]) => ({
    words: splitWords(name),
    packages: [...packages],
  }));
  return { names };
}

/** The manifest file name of a package, or of the root when `pkg` is `null`. */
export function manifestFileName(pkg: string | null): string {
  if (pkg === null) return ROOT_MANIFEST;
  const encoder = new TextEncoder();
  const segment = (s: string): string => {
    let out = "";
    for (const ch of s) {
      if (/^[A-Za-z0-9_-]$/.test(ch)) out += ch;
      else for (const b of encoder.encode(ch)) out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    return out;
  };
  return `${pkg.split(PACKAGE_SEPARATOR).map(segment).join(".")}.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The package a `sourceNode` names, `null` for an object in no package. */
function packageOfSourceNode(sourceNode: string): string | null {
  const dot = sourceNode.indexOf(".");
  const key = dot === -1 ? sourceNode : sourceNode.slice(0, dot);
  const at = key.lastIndexOf(PACKAGE_SEPARATOR);
  return at <= 0 ? null : key.slice(0, at);
}

/** The package whose object the file's stem names (the stem rule), `null` when none. */
function packageOfStem(path: string, index: PlacementIndex): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.indexOf(".");
  const stem = splitWords(dot === -1 ? base : base.slice(0, dot));
  let best = 0;
  const packages = new Set<string>();
  for (const { words, packages: declared } of index.names) {
    if (words.length === 0 || words.length > stem.length || words.length < best) continue;
    if (!words.every((w, i) => w === stem[i])) continue;
    // More words win; objects with equally many words pool their packages.
    if (words.length > best) packages.clear();
    best = words.length;
    for (const p of declared) packages.add(p);
  }
  if (packages.size !== 1) return null;
  const only = [...packages][0]!;
  return only === "" ? null : only;
}

/**
 * Which manifest an entry is filed under: its package, `null` for the root, or `undefined`
 * when nothing here decides (no `sourceNode` and no model), which keeps the entry where it is.
 */
export function placeEntry(
  path: string,
  entry: unknown,
  index: PlacementIndex | undefined,
): string | null | undefined {
  if (isRecord(entry) && typeof entry.sourceNode === "string") return packageOfSourceNode(entry.sourceNode);
  if (index !== undefined) return packageOfStem(path, index);
  return undefined;
}

/** What one read of the manifest found. */
export interface ManifestState {
  /** Every entry: the union of the legacy file and every package file. */
  entries: Record<string, unknown>;
  /** The manifest file each entry was read from (the legacy file is not a placement). */
  fileOf: Map<string, string>;
  /** The text of every file in `.hashes/` as read, so a write can skip a file that did not change. */
  texts: Map<string, string>;
  /** True when a legacy `.hashes.json` was found: the next write run migrates it. */
  legacy: boolean;
}

function readEntries(file: string): { entries: Record<string, unknown>; text: string } | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return { entries: isRecord(parsed) ? parsed : {}, text };
  } catch {
    // Corrupt reads as empty, which fails closed; the next write replaces it.
    return { entries: {}, text };
  }
}

function packageFiles(genStateDir: string): string[] {
  try {
    return readdirSync(join(genStateDir, HASHES_DIR))
      .filter((n) => n.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

/** True when the project has a manifest at all: the legacy file or a package file. */
export function manifestExists(genStateDir: string): boolean {
  return existsSync(join(genStateDir, LEGACY_HASHES_FILE)) || packageFiles(genStateDir).length > 0;
}

/** Read the whole manifest. Absent, unreadable or corrupt files read as empty. */
export function readManifestState(genStateDir: string): ManifestState {
  const state: ManifestState = { entries: {}, fileOf: new Map(), texts: new Map(), legacy: false };
  const legacy = readEntries(join(genStateDir, LEGACY_HASHES_FILE));
  if (legacy !== undefined) {
    state.legacy = true;
    Object.assign(state.entries, legacy.entries);
  }
  for (const name of packageFiles(genStateDir)) {
    const read = readEntries(join(genStateDir, HASHES_DIR, name));
    if (read === undefined) continue;
    state.texts.set(name, read.text);
    for (const [path, entry] of Object.entries(read.entries)) {
      state.entries[path] = entry;
      state.fileOf.set(path, name);
    }
  }
  return state;
}
