// server/typescript/packages/cli/src/lib/gen-fingerprint.ts
//
// ADR-0064 — `meta gen` skips rendering when the loaded model and its generators are
// unchanged since the last successful run.
//
// The key has two halves. The MODEL half is computed from the loaded model, never from the
// metadata source files (`modelHashTree` in codegen-ts): each root-level node in its
// canonical effective form, rolled up per package and for the model. The GENERATOR half is
// computed here: the built engine code, the codegen config and every owned generator it
// reaches, the template roots, the generator-declared extra inputs, the project config and
// the output-changing flags.
//
// The rule: the key may be wrong only in the safe direction. Anything the generator half
// cannot prove unchanged counts as changed, so its inputs are deliberately wide (a whole
// package's files in a checkout, every lockfile up the tree).
//
// Entries are named (kind, name, content hash) and folded into one key, so a later
// per-object or per-package key can reuse them for a subset of the inputs.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Collection } from "@metaobjectsdev/sdk/collection";
import { readManifestState } from "@metaobjectsdev/codegen-ts";
import { GEN_CONFIG_FILE } from "./gen-collection.js";
import { CLI_ALIASED_PACKAGES } from "./load-metaobjects-config.js";

/** Bumped whenever what goes into the fingerprint changes, so an old stored key never matches. */
export const FINGERPRINT_FORMAT = 3;

/** One input: what kind it is, which one, and the SHA-256 of its content. */
export interface FingerprintEntry {
  kind: string;
  name: string;
  hash: string;
}

/** The output-changing flags of a `meta gen` run. Anything else on the command line does not
 *  change what is written (`--format`, `--limit`, `--no-antipatterns`). */
export interface GenSelection {
  entities: readonly string[];
  generators: readonly string[] | undefined;
  strict: boolean;
  baseline: string;
}

/** What `.fingerprint-typescript.json` holds. */
export interface StoredFingerprint {
  format: number;
  key: string;
  /** The generator-declared extra inputs (project-relative), recorded so a check can hash
   *  them without resolving the generators first. */
  extras: string[];
  /** Every file the manifest records, by project-relative path, with the hash of its bytes
   *  as the run left them on disk. A file that changed since (a new hand edit, a checkout)
   *  makes the next run render: `meta gen` then puts it back or merges it, as `verify`
   *  tells the user it will. An edit the last run already kept is unchanged, and skips. */
  outputs: Record<string, string>;
  /** Absolute paths the run wrote outside the project root. The manifest records none of them,
   *  so a skip needs each to still exist. */
  untracked: string[];
}

export const FINGERPRINT_FILE = ".fingerprint-typescript.json";

/** Directories never descended into: dependencies, VCS and tool state, build caches. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".turbo", ".cache", ".metaobjects"]);
/** Directories inside an engine package that are not engine: its tests and reports. */
const PACKAGE_SKIP_DIRS = new Set([...SKIP_DIRS, "test", "tests", "reports", "coverage"]);
const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"];
const MANIFEST_FILES = ["package.json", "pyproject.toml"];

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function fileHash(path: string): string {
  return sha256(readFileSync(path));
}

/** Every regular file under `dir`, sorted, skipping `skip` directory names. */
function listFiles(dir: string, skip: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let names: string[];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const name of names) {
      const p = join(d, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        if (!skip.has(name)) walk(p);
      } else if (st.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** A file or every file under a directory, as entries named relative to `base`. An absent
 *  path is an entry too: its later appearance must change the key. */
function pathEntries(kind: string, path: string, base: string, skip: ReadonlySet<string> = SKIP_DIRS): FingerprintEntry[] {
  const name = (p: string): string => {
    const r = relative(base, p);
    return r.startsWith("..") || isAbsolute(r) ? p : r.split(sep).join("/");
  };
  if (!existsSync(path)) return [{ kind, name: name(path), hash: "absent" }];
  let st;
  try { st = statSync(path); } catch { return [{ kind, name: name(path), hash: "unreadable" }]; }
  if (st.isFile()) return [{ kind, name: name(path), hash: fileHash(path) }];
  return listFiles(path, skip).map((f) => ({ kind, name: name(f), hash: fileHash(f) }));
}

/** Fold entries into one key: sorted, so the order inputs were discovered in never matters. */
export function fingerprintKey(entries: readonly FingerprintEntry[]): string {
  const lines = entries.map((e) => `${e.kind}\t${e.name}\t${e.hash}`);
  lines.sort();
  return sha256(`metaobjects-gen-fingerprint ${FINGERPRINT_FORMAT}\n${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// Engine identity
// ---------------------------------------------------------------------------

/** The directory holding `<name>/package.json`, looked up from `fromDir` the way Node does. */
function findPackageDir(name: string, fromDir: string): string | undefined {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function dependencyNames(pkg: Record<string, unknown> | undefined): string[] {
  const deps = pkg?.dependencies;
  return typeof deps === "object" && deps !== null ? Object.keys(deps).sort() : [];
}

function isInstalled(dir: string): boolean {
  let real = dir;
  try { real = realpathSync(dir); } catch { /* keep the path as given */ }
  return real.split(sep).includes("node_modules");
}

/**
 * One package's identity. Installed from a registry (it lives under `node_modules`): its
 * `package.json`, which carries the version. A linked or source checkout: the content of
 * every file it ships, because its version does not move when its code does.
 */
function packageEntries(kind: string, dir: string): FingerprintEntry[] {
  const name = (readJson(join(dir, "package.json"))?.name as string | undefined) ?? dir;
  if (isInstalled(dir)) {
    return [{ kind, name: `${name}/package.json`, hash: fileHash(join(dir, "package.json")) }];
  }
  return listFiles(dir, PACKAGE_SKIP_DIRS).map((f) => ({
    kind,
    name: `${name}/${relative(dir, f).split(sep).join("/")}`,
    hash: fileHash(f),
  }));
}

/**
 * The packages a package runs on: every `@metaobjectsdev/*` dependency, followed all the
 * way, by full identity; every other dependency by its `package.json` (its version).
 */
function packageClosureEntries(kind: string, rootDir: string, seen: Set<string>): FingerprintEntry[] {
  const entries: FingerprintEntry[] = [];
  const visit = (dir: string): void => {
    let real = dir;
    try { real = realpathSync(dir); } catch { /* keep */ }
    if (seen.has(real)) return;
    seen.add(real);
    entries.push(...packageEntries(kind, dir));
    const pkg = readJson(join(dir, "package.json"));
    for (const dep of dependencyNames(pkg)) {
      const depDir = findPackageDir(dep, dir);
      if (depDir === undefined) {
        entries.push({ kind, name: `${dep}/package.json`, hash: "absent" });
        continue;
      }
      if (dep.startsWith("@metaobjectsdev/")) visit(depDir);
      else {
        let depReal = depDir;
        try { depReal = realpathSync(depDir); } catch { /* keep */ }
        if (seen.has(depReal)) continue;
        seen.add(depReal);
        entries.push({ kind, name: `${dep}/package.json`, hash: fileHash(join(depDir, "package.json")) });
      }
    }
  };
  visit(rootDir);
  return entries;
}

/** The CLI package's own directory (the one holding its `package.json`). */
function cliPackageDir(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = readJson(join(dir, "package.json"));
    if (pkg?.name === "@metaobjectsdev/cli") return dir;
    if (dirname(dir) === dir) return undefined;
    dir = dirname(dir);
  }
}

/**
 * The engine: this CLI and every package it runs (the config's imports of the packages in
 * `CLI_ALIASED_PACKAGES` are aliased onto these copies). A compiled single binary has no package tree on disk; its
 * identity is the binary's own content.
 */
function engineEntries(seen: Set<string>): FingerprintEntry[] {
  if (import.meta.url.includes("$bunfs")) {
    return [{ kind: "engine", name: "binary", hash: fileHash(process.execPath) }];
  }
  const dir = cliPackageDir();
  if (dir === undefined) return [{ kind: "engine", name: "cli", hash: "unresolved" }];
  return packageClosureEntries("engine", dir, seen);
}

// ---------------------------------------------------------------------------
// The project's generators: metaobjects.config.ts and everything it imports
// ---------------------------------------------------------------------------

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bexport\s+\*\s+from\s*)["'`]([^"'`]+)["'`]/g;
const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx", ".json"];

function resolveRelative(spec: string, fromFile: string): string | undefined {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base];
  // A `.js` specifier that names a `.ts` source (the ESM convention).
  const m = /\.(m|c)?js$/.exec(base);
  if (m !== null) candidates.push(base.slice(0, -m[0].length) + `.${m[1] ?? ""}ts`, base.slice(0, -m[0].length) + ".tsx");
  for (const ext of SOURCE_EXTS) candidates.push(base + ext);
  for (const ext of SOURCE_EXTS) candidates.push(join(base, `index${ext}`));
  for (const c of candidates) {
    try { if (statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return undefined;
}

function packageNameOf(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/**
 * `metaobjects.config.ts` and its import graph: every local module it reaches, by content,
 * and every package it imports, by identity. An owned (ejected) generator is a local module,
 * so editing it changes the key. A package the engine already covers is not repeated.
 */
function configGraphEntries(configFile: string, projectRoot: string, seen: Set<string>): FingerprintEntry[] {
  const entries: FingerprintEntry[] = [];
  const visited = new Set<string>();
  const queue = [configFile];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);
    entries.push(...pathEntries("generator-source", file, projectRoot));
    let text: string;
    try { text = readFileSync(file, "utf-8"); } catch { continue; }
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1]!;
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith(".") || spec.startsWith("/")) {
        const target = resolveRelative(spec, file);
        if (target === undefined) entries.push({ kind: "generator-source", name: `${relative(projectRoot, file)} -> ${spec}`, hash: "unresolved" });
        else if (!target.split(sep).includes("node_modules")) queue.push(target);
        continue;
      }
      const name = packageNameOf(spec);
      const dir = findPackageDir(name, dirname(file));
      if (dir === undefined) {
        // A builtin without the `node:` prefix, or a package that is not installed (the run
        // will fail on it). Either way its name is the stable answer.
        entries.push({ kind: "generator-package", name, hash: "unresolved" });
        continue;
      }
      // The engine's own packages are already counted: the CLI aliases the config's imports
      // of them onto its copies, so the project's copy is not what runs. Only those. Any other
      // `@metaobjectsdev/*` package (a pack, which the CLI does not depend on) runs from the
      // project like a third-party one, and a linked copy is hashed by content below.
      if (CLI_ALIASED_PACKAGES.has(name)) continue;
      entries.push(...packageClosureEntries("generator-package", dir, seen));
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// The whole input set
// ---------------------------------------------------------------------------

export interface GenInputs {
  projectRoot: string;
  genStateDir: string;
  /** Everything but the generator-declared extras, which only the stored fingerprint names.
   *  Holds the model entry once `withModel` added it. */
  entries: FingerprintEntry[];
}

/** The inputs with the loaded model's hash added: the model half of the key. */
export function withModel(inputs: GenInputs, model: { model: string }): GenInputs {
  return { ...inputs, entries: [...inputs.entries, { kind: "model", name: "(model)", hash: model.model }] };
}

/** The project's ancestors up to and including the repository root (the first with `.git`). */
function ancestorsToRepoRoot(start: string): string[] {
  const out: string[] = [];
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    out.push(dir);
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir) return out;
  }
}

/**
 * The generator half of the key: every input other than the loaded model that can change
 * what `meta gen` writes.
 *
 * `collection` is the collection the run GENERATES from and `discovered` the one it was
 * discovered as (the same object unless a sub-project declares its own sources; both
 * configs are inputs either way).
 */
export function computeGenInputs(
  projectRoot: string,
  discovered: Collection,
  collection: Collection,
  selection: GenSelection,
  /** Test seam: the engine's entries in place of this installation's own. */
  engine?: readonly FingerprintEntry[],
): GenInputs {
  const entries: FingerprintEntry[] = [];
  const seen = new Set<string>();

  entries.push({ kind: "tool", name: "fingerprint-format", hash: String(FINGERPRINT_FORMAT) });
  entries.push(...(engine ?? engineEntries(seen)));

  // The metadata itself is NOT read here: the model half of the key comes from the loaded
  // model (`withModel`). What sits beside it and is read raw is a template, not metadata:
  // prompt `.mustache` sources under a source root, which the docs-site generator reads.
  for (const root of collection.sourceRoots) {
    if (!existsSync(root)) continue;
    for (const f of listFiles(root, SKIP_DIRS)) {
      if (f.endsWith(".mustache")) entries.push(...pathEntries("templates", f, projectRoot));
    }
  }

  // Config: both config files of both collections, the codegen config and its imports.
  for (const dir of new Set([discovered.configDir, collection.configDir, projectRoot])) {
    entries.push(...pathEntries("config", join(dir, ".metaobjects", "config.json"), projectRoot));
  }
  const configFile = join(projectRoot, GEN_CONFIG_FILE);
  entries.push(...configGraphEntries(configFile, projectRoot, seen));

  // Templates and owned code: the project's `templates/` (prompt and template-codegen
  // sources, the owned docs-site theme's neighbours) and `codegen/` (owned generators and
  // anything they read beside them), whether or not the config imports them.
  entries.push(...pathEntries("templates", join(projectRoot, "templates"), projectRoot));
  entries.push(...pathEntries("generator-source", join(projectRoot, "codegen"), projectRoot));

  // Package manifests and lockfiles up to the repository root: an installed dependency's
  // version moves with them, and the shared-model generator reads the nearest version.
  for (const dir of ancestorsToRepoRoot(projectRoot)) {
    for (const f of [...MANIFEST_FILES, ...LOCKFILES]) {
      const p = join(dir, f);
      if (existsSync(p)) entries.push(...pathEntries("project", p, projectRoot));
    }
  }

  entries.push({
    kind: "selection",
    name: "flags",
    hash: sha256(JSON.stringify({
      entities: [...selection.entities].sort(),
      generators: selection.generators === undefined ? null : [...selection.generators].sort(),
      strict: selection.strict,
      baseline: selection.baseline,
    })),
  });

  return { projectRoot, genStateDir: join(projectRoot, ".metaobjects", ".gen-state"), entries };
}

/** The generator-declared extra inputs, as entries. */
export function extraEntries(projectRoot: string, extras: readonly string[]): FingerprintEntry[] {
  return [...new Set(extras)].sort().flatMap((p) => pathEntries("extra", resolve(projectRoot, p), projectRoot));
}

/** The key for `inputs` plus `extras`. */
export function keyFor(inputs: GenInputs, extras: readonly string[]): string {
  return fingerprintKey([...inputs.entries, ...extraEntries(inputs.projectRoot, extras)]);
}

// ---------------------------------------------------------------------------
// Stored state
// ---------------------------------------------------------------------------

export function readStoredFingerprint(genStateDir: string): StoredFingerprint | undefined {
  const raw = readJson(join(genStateDir, FINGERPRINT_FILE));
  if (raw === undefined) return undefined;
  const { format, key, extras, outputs } = raw;
  const untracked = raw.untracked ?? [];
  if (format !== FINGERPRINT_FORMAT || typeof key !== "string") return undefined;
  if (!Array.isArray(extras) || !extras.every((e) => typeof e === "string")) return undefined;
  if (typeof outputs !== "object" || outputs === null || Array.isArray(outputs)) return undefined;
  if (!Object.values(outputs).every((h) => typeof h === "string")) return undefined;
  if (!Array.isArray(untracked) || !untracked.every((p) => typeof p === "string")) return undefined;
  return {
    format, key, extras: extras as string[], outputs: outputs as Record<string, string>,
    untracked: untracked as string[],
  };
}

/**
 * Store the key after a successful run, with the on-disk hash of every file the manifest
 * now records. A recorded file that is missing makes no key at all: the next run renders.
 */
export function writeStoredFingerprint(
  projectRoot: string, genStateDir: string, key: string, extras: readonly string[],
  untracked: readonly string[] = [],
): void {
  const outputs: Record<string, string> = {};
  for (const path of [...recordedFiles(genStateDir).keys()].sort()) {
    const full = resolve(projectRoot, path);
    if (!existsSync(full)) return;
    outputs[path] = fileHash(full);
  }
  mkdirSync(genStateDir, { recursive: true });
  const body: StoredFingerprint = { format: FINGERPRINT_FORMAT, key, extras: [...new Set(extras)].sort(), outputs,
    untracked: [...new Set(untracked)].sort(),
  };
  writeFileSync(join(genStateDir, FINGERPRINT_FILE), JSON.stringify(body, null, 2) + "\n");
}

/** Forget the stored fingerprint. A real run does this before it writes anything, so a run
 *  that fails half-way can never leave a key that claims its half-written output is current. */
export function clearStoredFingerprint(genStateDir: string): void {
  rmSync(join(genStateDir, FINGERPRINT_FILE), { force: true });
}

/** The manifest's recorded paths and hashes (every package's manifest, ADR-0064 Amendment 1);
 *  empty when there is none. */
function recordedFiles(genStateDir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, value] of Object.entries(readManifestState(genStateDir).entries)) {
    if (typeof value === "string") out.set(path, value);
    else if (typeof value === "object" && value !== null && typeof (value as { hash?: unknown }).hash === "string") {
      out.set(path, (value as { hash: string }).hash);
    }
  }
  return out;
}

export type SkipVerdict =
  | { skip: true; recorded: string[] }
  | { skip: false; reason: string };

/**
 * The `meta gen` decision (ADR-0064 §3): skip when the stored key matches, and every file
 * the manifest records still exists with the bytes the last successful run left. It reads
 * the generated files (no render, no write); a file changed since then makes the run render.
 */
export function decideGenSkip(inputs: GenInputs): SkipVerdict {
  // A run that finds the pre-1.3.0 single manifest migrates it (ADR-0064 Amendment 1), which
  // is a write, so it never skips.
  if (readManifestState(inputs.genStateDir).legacy) {
    return { skip: false, reason: "the manifest is still in its single-file form" };
  }
  return decideKeyAndOutputs(inputs);
}

/** The skip decision without the migration rule: what a read-only `verify` may rely on. */
function decideKeyAndOutputs(inputs: GenInputs): SkipVerdict {
  // Never decide without the model half: the generator half alone says nothing about it.
  if (!inputs.entries.some((e) => e.kind === "model")) return { skip: false, reason: "the model was not hashed" };
  const stored = readStoredFingerprint(inputs.genStateDir);
  if (stored === undefined) return { skip: false, reason: "no stored fingerprint" };
  if (keyFor(inputs, stored.extras) !== stored.key) return { skip: false, reason: "an input changed" };
  const recorded = recordedFiles(inputs.genStateDir);
  for (const path of recorded.keys()) {
    const full = resolve(inputs.projectRoot, path);
    if (!existsSync(full)) return { skip: false, reason: `${path} is missing` };
    const left = stored.outputs[path];
    if (left === undefined || fileHash(full) !== left) return { skip: false, reason: `${path} changed since the last run` };
  }
  for (const path of stored.untracked) {
    if (!existsSync(path)) return { skip: false, reason: `${path} is missing` };
  }
  return { skip: true, recorded: [...recorded.keys()].sort() };
}

/**
 * The local `verify --codegen` shortcut (ADR-0064 §4): the stored key matches AND every
 * recorded file still hashes to its record. Hashing the files on disk is the point here: a
 * hand edit is not an input, so `gen` may skip over one, but `verify` must still see it.
 */
export function decideVerifyNoDrift(inputs: GenInputs): SkipVerdict {
  const verdict = decideKeyAndOutputs(inputs);
  if (!verdict.skip) return verdict;
  const recorded = recordedFiles(inputs.genStateDir);
  if (recorded.size === 0) return { skip: false, reason: "the manifest records no file" };
  for (const [path, hash] of recorded) {
    if (fileHash(resolve(inputs.projectRoot, path)) !== hash) return { skip: false, reason: `${path} differs from its record` };
  }
  return verdict;
}

/** True on a CI runner: `CI` set to anything but empty, `0` or `false`. */
export function isCi(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CI;
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}
