// server/typescript/packages/cli/src/lib/dependency-sync.ts
//
// FR-023 Phase 1a, Task 14 — the algorithm `meta deps sync` runs (DESIGN §4.1
// steps 1-5, 7-8; step 6, the usage-aware classifier, is superseded — DESIGN
// §11.3, "the committed artifact's diff in the consumer's history is the
// review"). Five functions, split so `--dry-run` is "run everything except
// the write": `readManifestDir` / `validateAgainstSpec` / `standaloneLoadCheck`
// read and validate one already-resolved dependency directory;
// `planSync` composes them over every declared dependency (transport
// resolution, per-dependency validation, the cross-dependency node-collision
// check); `applySync` is the only function that touches the filesystem.
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  codeSource,
  InMemoryStringSource,
  MetaDataLoader,
  METAMODEL_VERSION,
  packageOfResolutionKey,
  ParseError,
  type ErrorCode,
} from "@metaobjectsdev/metadata";
import {
  DEPS_DIR,
  DEFAULT_METAOBJECTS_DIR,
  INTEGRITY_PREFIX,
  LOCK_FILE,
  MANIFEST_FILE,
  DependencyManifestSchema,
  dependencyName,
  readLock,
  sha256Integrity,
  writeLock,
  type DependencyManifest,
  type DependencySpec,
  type Lock,
  type LockEntry,
} from "@metaobjectsdev/sdk";

/** `dependency-sync.ts`'s own `ParseError` factory for every
 *  `ERR_DEPENDENCY_MANIFEST_INVALID` case (DESIGN §4.1 step 2 and step 4):
 *  absent/invalid manifest, name mismatch, missing artifact, hash mismatch,
 *  a standalone load failure, or a `nodes`/`packages` mismatch against what
 *  the artifact actually declares. One thrower so every case names the
 *  dependency and carries the same code. */
function manifestInvalid(name: string, caller: string, detail: string): never {
  throw new ParseError(`dependency "${name}": ${detail}`, {
    code: "ERR_DEPENDENCY_MANIFEST_INVALID",
    source: codeSource(caller),
  });
}

/** The MAJOR half of a `major.minor` metamodel version string — mirrors the
 *  private helper of the same name in `sdk/src/dependencies.ts` (not
 *  exported there; the contract, "compare on the major alone" per ADR-0035
 *  Amendment 2, is small enough to restate rather than widen that module's
 *  public surface for one caller). */
function metamodelMajor(version: string): string {
  return version.split(".")[0] ?? version;
}

/** The MINOR half, as a number — 0 when absent (defensive; the manifest
 *  schema's `^\d+\.\d+$` regex already guarantees a minor is present). */
function metamodelMinor(version: string): number {
  return Number(version.split(".")[1] ?? 0);
}

function sameSortedArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((v, i) => v === right[i]);
}

/**
 * DESIGN §4.1 step 1 — resolve a dependency spec's transport to a directory.
 * `npm` / `python` refuse by design (Phase 1a ships `path` only — DESIGN
 * §11.3's transports table); a `path` that does not resolve to a directory on
 * disk is the SAME code (`ERR_DEPENDENCY_UNRESOLVED`) with a different
 * detail, because both are "the transport could not locate a directory
 * holding metaobjects.pkg.json" — the manifest read is a separate step
 * (`readManifestDir`) that only runs once a directory is in hand.
 */
export function resolveDependencyDir(configDir: string, spec: DependencySpec): string {
  const name = dependencyName(spec);
  if ("path" in spec) {
    const dir = resolve(configDir, spec.path);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new ParseError(
        `dependency "${name}": the "path" transport resolved to ${dir}, but no directory exists there`,
        { code: "ERR_DEPENDENCY_UNRESOLVED", source: codeSource("resolveDependencyDir") },
      );
    }
    return dir;
  }
  const kind = "npm" in spec ? "npm" : "python";
  throw new ParseError(
    `dependency "${name}": transport \`${kind}\` is not supported by this toolchain yet; use \`path\``,
    { code: "ERR_DEPENDENCY_UNRESOLVED", source: codeSource("resolveDependencyDir") },
  );
}

export interface ManifestRead {
  readonly manifest: DependencyManifest;
  readonly artifactContent: string;
}

/**
 * DESIGN §4.1 step 2 — read `<dir>/metaobjects.pkg.json`, strict, and verify
 * it is internally consistent with the artifact sitting beside it. Every
 * failure here is `ERR_DEPENDENCY_MANIFEST_INVALID`: absent, not JSON, fails
 * the schema, names a missing artifact, or the artifact's bytes don't hash
 * to the recorded `integrity` — a publisher who bypassed `sharedModelFile()`
 * is caught here, before the (more expensive) standalone load in
 * {@link standaloneLoadCheck}.
 */
export async function readManifestDir(dir: string, name: string): Promise<ManifestRead> {
  const manifestPath = join(dir, MANIFEST_FILE);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    manifestInvalid(name, "readManifestDir", `no ${MANIFEST_FILE} found at ${manifestPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    manifestInvalid(name, "readManifestDir", `${manifestPath} is not valid JSON: ${(err as Error).message}`);
  }

  const result = DependencyManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    manifestInvalid(name, "readManifestDir", `${manifestPath} failed schema validation — ${issues}`);
  }
  const manifest = result.data;

  const artifactPath = join(dir, manifest.artifact);
  let artifactContent: string;
  try {
    artifactContent = await readFile(artifactPath, "utf8");
  } catch {
    manifestInvalid(
      name,
      "readManifestDir",
      `the manifest names artifact "${manifest.artifact}", but it is missing at ${artifactPath}`,
    );
  }

  const actual = sha256Integrity(artifactContent);
  if (actual !== manifest.integrity) {
    manifestInvalid(
      name,
      "readManifestDir",
      `${artifactPath} hashes to ${actual}, but the manifest records ${manifest.integrity}`,
    );
  }

  return { manifest, artifactContent };
}

/**
 * DESIGN §4.1 step 2 (the `name ≠ spec.name` arm) + step 3 (`metamodelVersion`
 * major/minor). Returns an advisory warning string when the dependency was
 * published against a newer metamodel MINOR (the metadata contract still
 * loads; a MAJOR mismatch throws — ADR-0035 Amendment 2: the metadata
 * contract is promised on the major alone), `undefined` otherwise.
 */
export function validateAgainstSpec(manifest: DependencyManifest, spec: DependencySpec): string | undefined {
  const name = dependencyName(spec);
  if (manifest.name !== name) {
    manifestInvalid(
      name,
      "validateAgainstSpec",
      `the manifest declares name "${manifest.name}", but it is declared in config as "${name}"`,
    );
  }

  const manifestMajor = metamodelMajor(manifest.metamodelVersion);
  const toolchainMajor = metamodelMajor(METAMODEL_VERSION);
  if (manifestMajor !== toolchainMajor) {
    throw new ParseError(
      `dependency "${name}" was published against metamodel ${manifest.metamodelVersion}; this ` +
        `toolchain speaks ${METAMODEL_VERSION}. A different metamodel MAJOR is a different metadata ` +
        `contract — upgrade the toolchain, or use a release of "${name}" built against it.`,
      { code: "ERR_DEPENDENCY_METAMODEL_INCOMPATIBLE", source: codeSource("validateAgainstSpec") },
    );
  }

  if (metamodelMinor(manifest.metamodelVersion) > metamodelMinor(METAMODEL_VERSION)) {
    return (
      `dependency "${name}" was published against metamodel ${manifest.metamodelVersion}, newer than ` +
      `this toolchain's ${METAMODEL_VERSION} — vocabulary it uses that this toolchain does not yet ` +
      `have may fail to load.`
    );
  }
  return undefined;
}

/**
 * DESIGN §4.1 step 4 — load the artifact standalone with CORE providers only
 * (a consumer loads it with ITS OWN providers, never the publisher's; a
 * `MetaDataLoader` built with no `registry` option composes core providers by
 * default), strict, and check it declares EXACTLY the manifest's `nodes` and
 * `packages` — a publisher who hand-edited the manifest (or bypassed
 * `sharedModelFile()` entirely) is caught here.
 */
export async function standaloneLoadCheck(manifest: DependencyManifest, artifactContent: string): Promise<void> {
  const loader = new MetaDataLoader({ strict: true });
  const loaded = await loader.load([
    new InMemoryStringSource(artifactContent, { id: manifest.artifact }),
  ]);
  if (loaded.errors.length > 0) {
    manifestInvalid(
      manifest.name,
      "standaloneLoadCheck",
      `the artifact does not load standalone: ${loaded.errors[0]!.message}`,
    );
  }

  // ADR-0039 sanctioned own-only case: `MetaRoot` never `extends`, so its own
  // children ARE its effective children (the same reasoning
  // `sharedModelFile()`'s step 2 documents on the publisher side).
  const nodes = loaded.root.ownChildren().map((n) => n.resolutionKey());
  const packages = [...new Set(nodes.map((n) => packageOfResolutionKey(n)))];

  if (!sameSortedArray(nodes, manifest.nodes)) {
    manifestInvalid(
      manifest.name,
      "standaloneLoadCheck",
      `the artifact's top-level nodes (${[...nodes].sort().join(", ") || "(none)"}) do not match the ` +
        `manifest's "nodes" (${[...manifest.nodes].sort().join(", ") || "(none)"})`,
    );
  }
  if (!sameSortedArray(packages, manifest.packages)) {
    manifestInvalid(
      manifest.name,
      "standaloneLoadCheck",
      `the artifact's packages (${[...packages].sort().join(", ") || "(none)"}) do not match the ` +
        `manifest's "packages" (${[...manifest.packages].sort().join(", ") || "(none)"})`,
    );
  }
}

/** The declared spec's transport, verbatim, minus `name` — a lock entry's
 *  `resolvedFrom` (DESIGN §3.3). */
function resolvedFromOf(spec: DependencySpec): LockEntry["resolvedFrom"] {
  if ("path" in spec) return { path: spec.path };
  if ("npm" in spec) return spec.dir === undefined ? { npm: spec.npm } : { npm: spec.npm, dir: spec.dir };
  return spec.dir === undefined ? { python: spec.python } : { python: spec.python, dir: spec.dir };
}

/** One dependency this run will (re)sync — either brand new or a changed/
 *  unchanged re-sync of one already in the lock. */
export interface SyncedDependencyPlan {
  readonly name: string;
  readonly action: "sync" | "unchanged";
  readonly manifest: DependencyManifest;
  readonly artifactContent: string;
  readonly resolvedFrom: LockEntry["resolvedFrom"];
  readonly oldEntry: LockEntry | undefined;
}

/** A lock entry whose dependency is no longer declared in config. */
export interface PrunedDependencyPlan {
  readonly name: string;
  readonly entry: LockEntry;
}

export interface SyncPlan {
  /** Target dependencies (all declared, or the requested subset), in name order. */
  readonly plans: readonly SyncedDependencyPlan[];
  /** Declared-but-not-targeted lock entries (only when a name filter was
   *  given) — carried into the new lock untouched. */
  readonly carryForward: ReadonlyMap<string, LockEntry>;
  /** Lock entries whose dependency config no longer declares, in name order. */
  readonly prunes: readonly PrunedDependencyPlan[];
  /** Advisory metamodel-minor-ahead warnings, one per affected dependency. */
  readonly warnings: readonly string[];
}

/**
 * DESIGN §4.1 steps 1-5, for every declared dependency (or the requested
 * `filterNames` subset), in name order. Read-only: resolves each transport,
 * validates its manifest and artifact, and checks the WHOLE resulting node
 * set (freshly-resolved targets plus whatever untouched lock entries carry
 * forward) for collisions — nothing is written here, which is what makes
 * `--dry-run` "run this and skip `applySync`."
 */
export async function planSync(
  configDir: string,
  specs: readonly DependencySpec[],
  lock: Lock | undefined,
  filterNames: readonly string[] = [],
): Promise<SyncPlan> {
  const allNames = specs.map(dependencyName);
  const declared = new Set(allNames);

  let targets: DependencySpec[];
  if (filterNames.length === 0) {
    targets = [...specs];
  } else {
    const unknown = filterNames.filter((n) => !declared.has(n));
    if (unknown.length > 0) {
      throw new ParseError(
        `meta deps sync: not declared in ${DEFAULT_METAOBJECTS_DIR}/config.json: ${unknown.join(", ")}` +
          (allNames.length > 0
            ? ` (declared: ${[...declared].sort().join(", ")})`
            : " (no dependencies declared)"),
        { code: "ERR_DEPENDENCY_UNRESOLVED", source: codeSource("planSync") },
      );
    }
    targets = specs.filter((s) => filterNames.includes(dependencyName(s)));
  }
  targets.sort((a, b) => dependencyName(a).localeCompare(dependencyName(b)));

  const targetNames = new Set(targets.map(dependencyName));
  const oldEntries = lock?.dependencies ?? {};

  // Node ownership seeds from untouched (carried-forward) lock entries, so a
  // freshly-resolved target's nodes are checked against what already stands,
  // not just against each other.
  const nodeOwner = new Map<string, string>();
  const carryForward = new Map<string, LockEntry>();
  for (const [name, entry] of Object.entries(oldEntries)) {
    if (declared.has(name) && !targetNames.has(name)) {
      carryForward.set(name, entry);
      for (const node of entry.nodes) nodeOwner.set(node, name);
    }
  }

  const warnings: string[] = [];
  const plans: SyncedDependencyPlan[] = [];
  for (const spec of targets) {
    const name = dependencyName(spec);
    const dir = resolveDependencyDir(configDir, spec);
    const { manifest, artifactContent } = await readManifestDir(dir, name);
    const warning = validateAgainstSpec(manifest, spec);
    if (warning !== undefined) warnings.push(warning);
    await standaloneLoadCheck(manifest, artifactContent);

    for (const node of manifest.nodes) {
      const prior = nodeOwner.get(node);
      if (prior !== undefined && prior !== name) {
        throw new ParseError(
          `dependencies "${prior}" and "${name}" both export "${node}" — one fully-qualified node ` +
            `cannot come from two places, and whichever loaded second would silently win`,
          { code: "ERR_DEPENDENCY_NODE_COLLISION", source: codeSource("planSync") },
        );
      }
      nodeOwner.set(node, name);
    }

    const oldEntry = oldEntries[name];
    const action: "sync" | "unchanged" =
      oldEntry !== undefined && oldEntry.integrity === manifest.integrity ? "unchanged" : "sync";
    plans.push({ name, action, manifest, artifactContent, resolvedFrom: resolvedFromOf(spec), oldEntry });
  }

  const prunes: PrunedDependencyPlan[] = Object.entries(oldEntries)
    .filter(([name]) => !declared.has(name))
    .map(([name, entry]) => ({ name, entry }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { plans, carryForward, prunes, warnings };
}

export interface DependencyReportLine {
  readonly name: string;
  readonly action: "sync" | "unchanged" | "prune";
  readonly line: string;
}

export interface ApplySyncResult {
  readonly lock: Lock;
  readonly report: readonly DependencyReportLine[];
}

/** First 8 hex chars after the `sha256-` (`INTEGRITY_PREFIX`) prefix — the
 *  report format's `<hash8>`. Exported so every caller — `deps.ts`'s `deps
 *  list` rendering, tests — shares this ONE definition rather than each
 *  reimplementing the slice with its own inlined `"sha256-"` literal. */
export function hash8(integrity: string): string {
  return integrity.slice(INTEGRITY_PREFIX.length, INTEGRITY_PREFIX.length + 8);
}

/**
 * DESIGN §4.1 steps 7-8. `opts.dryRun` runs the exact same reporting pass and
 * writes nothing — no directory emptied, no artifact copied, no lock touched
 * — which is what makes `--dry-run` a true preview of `planSync`'s verdict
 * rather than a second code path that could drift from it.
 */
export async function applySync(
  configDir: string,
  plan: SyncPlan,
  opts: { readonly dryRun: boolean },
): Promise<ApplySyncResult> {
  const dependencies: Record<string, LockEntry> = {};
  for (const [name, entry] of plan.carryForward) dependencies[name] = entry;

  const report: DependencyReportLine[] = [];

  for (const p of plan.plans) {
    const newEntry: LockEntry = {
      version: p.manifest.version,
      metamodelVersion: p.manifest.metamodelVersion,
      artifact: p.manifest.artifact,
      integrity: p.manifest.integrity,
      packages: p.manifest.packages,
      nodes: p.manifest.nodes,
      resolvedFrom: p.resolvedFrom,
    };
    dependencies[p.name] = newEntry;

    if (p.action === "unchanged") {
      report.push({ name: p.name, action: "unchanged", line: `unchanged ${p.name} ${p.manifest.version}` });
      continue;
    }

    const oldVersion = p.oldEntry?.version ?? "(new)";
    const oldHash = p.oldEntry !== undefined ? hash8(p.oldEntry.integrity) : "(new)";
    const newHash = hash8(p.manifest.integrity);
    const verb = opts.dryRun ? "would sync" : "synced";
    report.push({
      name: p.name,
      action: "sync",
      line: `${verb} ${p.name} ${oldVersion}→${p.manifest.version} (${oldHash}→${newHash})`,
    });

    if (!opts.dryRun) {
      const depDir = join(configDir, DEFAULT_METAOBJECTS_DIR, DEPS_DIR, p.name);
      await rm(depDir, { recursive: true, force: true });
      await mkdir(depDir, { recursive: true });
      await writeFile(join(depDir, p.manifest.artifact), p.artifactContent, "utf8");
    }
  }

  for (const pr of plan.prunes) {
    report.push({
      name: pr.name,
      action: "prune",
      line: opts.dryRun ? `would prune ${pr.name}` : `pruned ${pr.name}`,
    });
    if (!opts.dryRun) {
      const depDir = join(configDir, DEFAULT_METAOBJECTS_DIR, DEPS_DIR, pr.name);
      await rm(depDir, { recursive: true, force: true });
    }
  }

  const lock: Lock = { schema_version: 1, dependencies };
  // Nothing to reconcile (no target dependency and no prune) is a true no-op —
  // a project declaring no dependencies (and never having synced any) must
  // not gain a `deps.lock.json` from a bare `meta deps sync`. `plan.prunes`
  // being non-empty is what still writes when EVERY dependency was just
  // removed from config: that run must produce a lock with an EMPTY
  // `dependencies` map, not leave the stale one standing.
  if (!opts.dryRun && (plan.plans.length > 0 || plan.prunes.length > 0)) {
    await writeLock(configDir, lock);
  }

  return { lock, report };
}

// ---------------------------------------------------------------------------
// Task 15 — `meta deps check` / `verify --deps`: does the INSTALLED artifact
// (re-resolved live, exactly as `sync` steps 1-2 do) still hash to what the
// LOCK pinned? (DESIGN §2.3 "the lock pins bytes", §4.1 as amended by §11 —
// no usage-aware classification, just current/drifted/unresolved.)
// ---------------------------------------------------------------------------

/**
 * `readLock`, converted into a diagnostic that NAMES the file rather than
 * letting a corrupted committed lock's raw `JSON.parse`/`ZodError` surface as
 * an unhandled rejection. `deps.lock.json` is checked-in, hand-editable, and
 * merge-conflictable — a realistic way for it to break — and `bin/meta.ts`'s
 * `run(...).then((code) => process.exit(code))` has no top-level `.catch()`,
 * so an uncaught throw here would crash the process with a stack trace
 * instead of the clean exit code every other failure in this command gets.
 *
 * The ONE call site for the sdk's `readLock` in `cli/src` — `deps.ts`'s
 * `sync`/`list`/`check` handlers and `verify.ts`'s `--deps` gate all call
 * THIS wrapper instead, so the diagnostic can never go stale in one of them.
 */
export async function readLockOrThrow(configDir: string): Promise<Lock | undefined> {
  try {
    return await readLock(configDir);
  } catch (err) {
    throw new Error(
      `${DEFAULT_METAOBJECTS_DIR}/${LOCK_FILE} is corrupted and could not be read: ${(err as Error).message}. ` +
        "Fix it by hand, or delete it and re-run `meta deps sync` to regenerate it.",
    );
  }
}

/**
 * `meta deps check` / `verify --deps`'s classification for one declared
 * dependency (DESIGN §4.1 as amended by §11 — no usage-aware classifier, just
 * "does the installed hash match the lock"):
 *  - `current`    — resolved fine, and its installed artifact hashes to
 *                   exactly what the lock pinned.
 *  - `drifted`    — resolved fine, but the hash differs.
 *  - `unresolved` — step 1 (`resolveDependencyDir`) or step 2
 *                   (`readManifestDir`) failed, OR the dependency is declared
 *                   but the lock has no entry for it at all (nothing to
 *                   compare against — "a check that cannot check must not
 *                   pass"). `detail` carries WHY.
 *
 * `lockVersion`/`lockIntegrity` are `undefined` exactly when there is no lock
 * entry; `installedVersion`/`installedIntegrity` are `undefined` exactly when
 * resolution itself failed.
 */
export interface DependencyCheckResult {
  readonly name: string;
  readonly status: "current" | "drifted" | "unresolved";
  readonly lockVersion: string | undefined;
  readonly lockIntegrity: string | undefined;
  readonly installedVersion: string | undefined;
  readonly installedIntegrity: string | undefined;
  /** Populated for `unresolved` only — the reason, with the redundant
   *  `dependency "<name>": ` prefix (`manifestInvalid`/`resolveDependencyDir`'s
   *  own convention) stripped, since `formatCheckLine` already names the
   *  dependency once in its own lead-in. */
  readonly detail: string | undefined;
}

/** Strips the `dependency "<name>": ` prefix `resolveDependencyDir` and
 *  `readManifestDir`'s errors always carry — `formatCheckLine` names the
 *  dependency itself, so repeating it verbatim inside `detail` would read
 *  twice. */
function stripDependencyPrefix(name: string, message: string): string {
  const prefix = `dependency "${name}": `;
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

/**
 * DESIGN §4.1 as amended by §11 — resolve each declared dependency EXACTLY as
 * `sync` steps 1-2 do (`resolveDependencyDir` then `readManifestDir`; never
 * step 3's `validateAgainstSpec` — `check` compares hashes, it does not
 * re-validate the spec), then compare the freshly-read artifact's TRUE hash
 * (re-hashed here from the bytes `readManifestDir` returned, never the
 * installed manifest's `integrity` field taken on faith) against the lock's.
 *
 * Read-only: nothing here writes the lock, the snapshot, or touches
 * `.metaobjects/deps/` — that is `sync`'s job. Every declared dependency gets
 * exactly one result, in name order.
 */
export async function checkDependencies(
  configDir: string,
  specs: readonly DependencySpec[],
  lock: Lock | undefined,
): Promise<DependencyCheckResult[]> {
  const entries = lock?.dependencies ?? {};
  const sorted = [...specs].sort((a, b) => dependencyName(a).localeCompare(dependencyName(b)));
  const results: DependencyCheckResult[] = [];

  for (const spec of sorted) {
    const name = dependencyName(spec);
    const lockEntry = entries[name];

    try {
      const dir = resolveDependencyDir(configDir, spec);
      const { manifest, artifactContent } = await readManifestDir(dir, name);
      // Never trust the manifest's own `integrity` field for the comparison —
      // re-hash the bytes actually sitting on disk right now.
      //
      // Right now this cannot observe a divergence from `manifest.integrity`:
      // `readManifestDir` above (§4.1 step 2, :152-159) already throws
      // `ERR_DEPENDENCY_MANIFEST_INVALID` unless `sha256Integrity(artifactContent)
      // === manifest.integrity`, so by the time this line runs the two values are
      // provably equal — this call is redundant WORK, not redundant SAFETY. The
      // safety it buys is against `readManifestDir` changing out from under this
      // function: if that check is ever relaxed, moved, or made conditional, this
      // line becomes the ONLY thing standing between `check` and trusting a
      // self-declared field, with no test that would fail to say so (the
      // divergent state is unreachable through `checkDependencies`'s public
      // signature today, precisely because `readManifestDir` forecloses it
      // first). Read `manifest.integrity` here only if you have also confirmed
      // `readManifestDir` still enforces the hash match unconditionally.
      const installedIntegrity = sha256Integrity(artifactContent);

      if (lockEntry === undefined) {
        results.push({
          name,
          status: "unresolved",
          lockVersion: undefined,
          lockIntegrity: undefined,
          installedVersion: manifest.version,
          installedIntegrity,
          detail: "declared, and resolves, but is not in the lock yet",
        });
        continue;
      }

      results.push({
        name,
        status: installedIntegrity === lockEntry.integrity ? "current" : "drifted",
        lockVersion: lockEntry.version,
        lockIntegrity: lockEntry.integrity,
        installedVersion: manifest.version,
        installedIntegrity,
        detail: undefined,
      });
    } catch (err) {
      results.push({
        name,
        status: "unresolved",
        lockVersion: lockEntry?.version,
        lockIntegrity: lockEntry?.integrity,
        installedVersion: undefined,
        installedIntegrity: undefined,
        detail: stripDependencyPrefix(name, (err as Error).message),
      });
    }
  }

  return results;
}

/** The one code every `checkDependencies` failure (`drifted` or `unresolved`)
 *  is reported under — `deps.ts`'s `check` handler and `verify.ts`'s `--deps`
 *  gate both surface it, so it is named once here rather than inlined twice. */
export const ERR_DEPENDENCY_UPSTREAM_DRIFT: ErrorCode = "ERR_DEPENDENCY_UPSTREAM_DRIFT";

/**
 * `meta deps check` / `verify --deps`'s one report line per dependency. The
 * `drifted` shape is pinned exactly by the task brief:
 * `<name>: drifted — lock <v> (<hash8>), installed <v> (<hash8>); run meta
 * deps sync and review the artifact diff`.
 */
export function formatCheckLine(result: DependencyCheckResult): string {
  const lockDesc = `${result.lockVersion ?? "(none)"} (${
    result.lockIntegrity !== undefined ? hash8(result.lockIntegrity) : "n/a"
  })`;
  const installedDesc = `${result.installedVersion ?? "(none)"} (${
    result.installedIntegrity !== undefined ? hash8(result.installedIntegrity) : "n/a"
  })`;
  switch (result.status) {
    case "current":
      return `${result.name}: current — ${lockDesc}`;
    case "drifted":
      return (
        `${result.name}: drifted — lock ${lockDesc}, installed ${installedDesc}; ` +
        "run meta deps sync and review the artifact diff"
      );
    case "unresolved":
      return (
        `${result.name}: unresolved — ${result.detail ?? "could not resolve the dependency"}; ` +
        "run meta deps sync once the dependency is reachable"
      );
  }
}
