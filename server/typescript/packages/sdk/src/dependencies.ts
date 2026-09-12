// server/typescript/packages/sdk/src/dependencies.ts
//
// FR-023 — metadata dependencies: the `dependencies` key of
// `.metaobjects/config.json` (DESIGN §3.1), the manifest/lock schemas and
// integrity hashing (DESIGN §3.2, §3.3, minus `mode` — DESIGN §11.1/§11.3),
// the constants every port shares, and the snapshot verification +
// exclusion-key helpers `resolveCollection` composes into its predicates
// (`verifySnapshot`, `importedPackagesOf`, `importedNodesOf`,
// `explicitlyIncludes` — DESIGN §4.2, §11.1 item 2).
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { codeSource, METAMODEL_VERSION, packageOfResolutionKey, ParseError } from "@metaobjectsdev/metadata";
import { DEFAULT_METAOBJECTS_DIR } from "./metadata-files.js";

/** Directory (under `.metaobjects/`) holding the synced snapshot artifacts,
 *  one subdirectory per dependency name: `.metaobjects/deps/<name>/`. */
export const DEPS_DIR = "deps";

/** `meta deps sync`'s output — the only writer (DESIGN §3.3). */
export const LOCK_FILE = "deps.lock.json";

/** The publisher-generated manifest sitting beside a dependency's artifact
 *  (DESIGN §3.2). */
export const MANIFEST_FILE = "metaobjects.pkg.json";

/** Suffix of a dependency's canonical-JSON artifact file, e.g.
 *  `acme-common.metaobjects.json` (DESIGN §3.5). */
export const ARTIFACT_SUFFIX = ".metaobjects.json";

/** Prefix of a dependency artifact's `FileSource` id: `dep:<name>/<artifact>`
 *  (DESIGN §2.3, "Source ids"). */
export const DEPENDENCY_SOURCE_ID_PREFIX = "dep:";

/** Prefix of the `integrity` field's value: `"sha256-" + lowercase hex sha256
 *  of the artifact bytes` (DESIGN §3, "Hash format"). */
export const INTEGRITY_PREFIX = "sha256-";

/**
 * A declared dependency: a `name` and exactly one transport (`path` | `npm` |
 * `python`). `npm`/`python` optionally carry `dir` — the subdirectory under
 * the resolved package holding `metaobjects.pkg.json`; `path` never does,
 * since the path itself already names that directory.
 *
 * Mirrors the hand-written union below in `DependencySpecSchema` — the same
 * two-direction parity guard `SourceSpec`/`SourceSpecSchema` carries (see
 * `config.ts`), so the schema and this type cannot silently drift.
 */
export type DependencySpec = { readonly name: string } & (
  | { readonly path: string }
  | { readonly npm: string; readonly dir?: string | undefined }
  | { readonly python: string; readonly dir?: string | undefined }
);

/** `/^[a-z0-9][a-z0-9._-]*$/` — lowercase, digits, `.`/`_`/`-`, starting with
 *  an alphanumeric (DESIGN §3.1). Deliberately narrower than an npm package
 *  name (no leading `@acme/`) — this is the LOCAL alias the consumer's own
 *  config, lock and `.metaobjects/deps/<name>/` directory key on, not the
 *  transport's own package name. */
const DependencyName = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);

/**
 * `.strict()` on every arm, same rationale as `SourceSpecSchema` in
 * `config.ts`: a config schema that silently strips an unknown key would let
 * `{ name: "a", path: "x", pathh: "typo" }` parse clean instead of erroring
 * on the typo. A `z.union` (rather than a discriminated union) because the
 * three arms share no single literal discriminator key — the transport key
 * itself (`path`/`npm`/`python`) is what distinguishes them, and that is
 * exactly what the "two transports in one spec" / "no transport" refusals
 * below exercise: neither shape matches any arm, so the union fails closed.
 * `mode` is REMOVED (FR-023 §11.3 — superseded by explicit `scope.include`).
 */
export const DependencySpecSchema = z.union([
  z.object({ name: DependencyName, path: z.string().min(1) }).strict(),
  z.object({ name: DependencyName, npm: z.string().min(1), dir: z.string().min(1).optional() }).strict(),
  z.object({ name: DependencyName, python: z.string().min(1), dir: z.string().min(1).optional() }).strict(),
]);

/** The declared name of a dependency spec — `name` is common to all three
 *  transport arms, so this needs no narrowing. Exists so callers never
 *  inline `.name` and so later tasks (manifest/lock keying) have one place
 *  this projection is defined. */
export function dependencyName(spec: DependencySpec): string {
  return spec.name;
}

/** `/^sha256-[0-9a-f]{64}$/` — the `integrity` field's shape (DESIGN §3,
 *  "Hash format"): {@link INTEGRITY_PREFIX} followed by 64 lowercase hex
 *  digits (a sha256 digest). */
export const IntegritySchema = z.string().regex(/^sha256-[0-9a-f]{64}$/);

/** `true` iff `values` is already in strict ascending order. Bounded by the
 *  loop (`i` ranges over `1..values.length-1`, so both indices below are
 *  always in range) — the non-null assertions are safe, not a widening of
 *  `noUncheckedIndexedAccess`. */
function isSortedAscending(values: readonly string[]): boolean {
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1]! >= values[i]!) return false;
  }
  return true;
}

/**
 * A non-empty string array that must already be in ascending order — the
 * shared shape of `packages` and `nodes` on both {@link DependencyManifestSchema} and
 * {@link LockEntrySchema}. Sortedness is validated, never imposed here: the
 * writer (the publisher's `sharedModelFile()` generator, and `meta deps
 * sync` copying the manifest into the lock) is responsible for producing
 * sorted output; this schema only refuses to load one that isn't.
 */
function sortedStringArray(fieldName: string) {
  return z
    .array(z.string().min(1))
    .refine(isSortedAscending, { message: `${fieldName} must be sorted` });
}

/**
 * `metaobjects.pkg.json` (DESIGN §3.2) — generated by the publisher's
 * `sharedModelFile()` and read by the consumer's `meta deps sync`.
 *
 * NOT named `Manifest`/`DependencyManifestSchema`, deliberately: the package barrel
 * already publishes an agent-context `Manifest` (`scaffold.ts`) through an
 * `export *`, and an explicit export SHADOWS a star one — so the bare name
 * here silently re-typed every consumer asking the root barrel for the
 * agent-context manifest. `DependencyManifest` also reads right beside its own
 * siblings (`DependencySpec`, `LockEntry`, `Lock`, `ResolvedDependency`).
 * `.strict()`: an unknown key — in particular a resurrected `mode` (FR-023
 * §11.3, removed by Task 6 and not reintroduced) — is a hard parse error
 * rather than one zod silently strips.
 */
export const DependencyManifestSchema = z
  .object({
    schema_version: z.literal(1),
    name: DependencyName,
    /** The host package's own version (semver-ish; not narrowed further here). */
    version: z.string().min(1),
    /** The toolchain's `METAMODEL_VERSION` at generation time — `major.minor`,
     *  no patch. */
    metamodelVersion: z.string().regex(/^\d+\.\d+$/),
    /** The sibling artifact file's basename, e.g. `acme-common.metaobjects.json`. */
    artifact: z.string().endsWith(ARTIFACT_SUFFIX),
    /** `sha256Integrity` of the artifact's bytes. */
    integrity: IntegritySchema,
    /** Every package a top-level node in the artifact declares, sorted —
     *  the exclusion key (DESIGN §11.5): a consumer's top-level node whose
     *  package is in here, and whose FQN is NOT in `nodes`, is declared into
     *  a package it does not own (`ERR_DEPENDENCY_PACKAGE_NOT_OWNED`, a
     *  later task). */
    packages: sortedStringArray("packages"),
    /** The resolution key of every top-level node in the artifact, sorted —
     *  the public surface. Retained for `sync`'s artifact-vs-manifest check,
     *  node-collision detection, and the package-ownership refusal above
     *  (DESIGN §11.5) — it is NOT the exclusion key itself. */
    nodes: sortedStringArray("nodes"),
  })
  .strict();

export type DependencyManifest = z.infer<typeof DependencyManifestSchema>;

/**
 * The one transport a lock entry's `resolvedFrom` carries — the declared
 * spec's transport, verbatim, minus `name` (a lock entry is already keyed by
 * name under `LockSchema.dependencies`). Mirrors `DependencySpecSchema`'s
 * three arms exactly, `name` aside, including the `.strict()` on every arm:
 * `{ path: "x", npm: "y" }` must match no arm, never silently pick one.
 */
const ResolvedFromSchema = z.union([
  z.object({ path: z.string().min(1) }).strict(),
  z.object({ npm: z.string().min(1), dir: z.string().min(1).optional() }).strict(),
  z.object({ python: z.string().min(1), dir: z.string().min(1).optional() }).strict(),
]);

/**
 * One entry of `.metaobjects/deps.lock.json`'s `dependencies` map (DESIGN
 * §3.3) — the manifest's fields minus `schema_version`/`name` (both
 * implicit: every entry is schema_version 1, and it is already keyed by
 * name) plus `resolvedFrom`. No `mode` (FR-023 §11.3 — removed, not
 * reintroduced).
 */
export const LockEntrySchema = z
  .object({
    version: z.string().min(1),
    metamodelVersion: z.string().regex(/^\d+\.\d+$/),
    artifact: z.string().endsWith(ARTIFACT_SUFFIX),
    integrity: IntegritySchema,
    packages: sortedStringArray("packages"),
    nodes: sortedStringArray("nodes"),
    resolvedFrom: ResolvedFromSchema,
  })
  .strict();

export type LockEntry = z.infer<typeof LockEntrySchema>;

/**
 * `.metaobjects/deps.lock.json` (DESIGN §3.3) — written by `meta deps sync`
 * only. `dependencies` is keyed by dependency name; the keys must already be
 * sorted — deterministic across machines, no timestamps, no host paths.
 */
export const LockSchema = z
  .object({
    schema_version: z.literal(1),
    dependencies: z.record(DependencyName, LockEntrySchema),
  })
  .strict()
  .refine((lock) => isSortedAscending(Object.keys(lock.dependencies)), {
    message: "deps.lock.json: dependency keys must be sorted",
  });

export type Lock = z.infer<typeof LockSchema>;

/**
 * A resolved dependency, ready for the collection resolver (a later task) to
 * fold its artifact into the loaded tree. Nothing in this task produces one
 * — declared here (a named, documented interface) rather than left for a
 * later task to invent ad hoc or reach for `any`, so that task's signature
 * is fixed now.
 */
export type ResolvedDependency = {
  readonly name: string;
  readonly version: string;
  readonly packages: readonly string[];
  readonly nodes: readonly string[];
  readonly artifactPath: string;
  readonly sourceId: string;
};

/** `"sha256-" + lowercase hex sha256 of `bytes`` (DESIGN §3, "Hash format"). */
export function sha256Integrity(bytes: Uint8Array | string): string {
  return `${INTEGRITY_PREFIX}${createHash("sha256").update(bytes).digest("hex")}`;
}

/** `dep:<name>/<artifact>` — a dependency artifact's `FileSource` id
 *  (DESIGN §2.3, "Source ids"). */
export function dependencySourceId(name: string, artifact: string): string {
  return `${DEPENDENCY_SOURCE_ID_PREFIX}${name}/${artifact}`;
}

/**
 * Read `.metaobjects/deps.lock.json` under `configDir`, if present. Returns
 * `undefined` when the file does not exist — a project declaring no
 * dependencies has no lock file, and that is not an error. A present but
 * malformed file (bad JSON, or a shape {@link LockSchema} rejects) throws.
 */
export async function readLock(configDir: string): Promise<Lock | undefined> {
  const path = join(configDir, DEFAULT_METAOBJECTS_DIR, LOCK_FILE);
  try {
    const s = await stat(path);
    if (!s.isFile()) return undefined;
  } catch {
    return undefined;
  }
  const raw = await readFile(path, "utf8");
  return LockSchema.parse(JSON.parse(raw));
}

/**
 * Write `.metaobjects/deps.lock.json` under `configDir`. Deterministic
 * output regardless of the input map's own key order: dependency keys
 * sorted, 2-space indent, trailing newline — no timestamps, no host paths —
 * so two machines that synced the same upstream bytes produce a
 * byte-identical lock file.
 */
export async function writeLock(configDir: string, lock: Lock): Promise<void> {
  const sortedDependencies = Object.fromEntries(
    Object.entries(lock.dependencies).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const sorted: Lock = { ...lock, dependencies: sortedDependencies };
  LockSchema.parse(sorted); // validate before writing, mirrors saveConfig (config.ts)
  const path = join(configDir, DEFAULT_METAOBJECTS_DIR, LOCK_FILE);
  await writeFile(path, JSON.stringify(sorted, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Snapshot verification + the exclusion key (DESIGN §4.2, §11.1 item 2)
// ---------------------------------------------------------------------------

/** The MAJOR half of a `major.minor` metamodel version. The metadata contract
 *  is promised on the major alone (ADR-0035 Amendment 2): a dependency
 *  published against `1.3` loads fine here at `1.0`, one published against
 *  `2.0` does not. */
function metamodelMajor(version: string): string {
  return version.split(".")[0] ?? version;
}

/**
 * Every stale-snapshot refusal, in one place so every one of them ends with the
 * command that fixes it. `never` (a function DECLARATION, so control-flow
 * narrowing applies at the call sites) — a caller writes the check and the
 * message, never the throw.
 */
function staleSnapshot(detail: string): never {
  throw new ParseError(`${detail}; run \`meta deps sync\``, {
    code: "ERR_DEPENDENCY_SNAPSHOT_STALE",
    source: codeSource("verifySnapshot"),
  });
}

/**
 * Verify a project's committed snapshot against its lock, and resolve the
 * dependencies the collection will load FIRST (DESIGN §4.2 step 2-3).
 *
 * The lock is the contract and the snapshot is the payload, so every way they
 * can disagree is one refusal with one remedy — a missing lock, a lock entry
 * with no spec, a spec with no lock entry, a missing artifact, an artifact whose
 * bytes hash to something else. Two failures are NOT staleness and get their own
 * codes, because `meta deps sync` would not fix either: a dependency published
 * against a different metamodel MAJOR (`ERR_DEPENDENCY_METAMODEL_INCOMPATIBLE`)
 * and two dependencies exporting the same fully-qualified node
 * (`ERR_DEPENDENCY_NODE_COLLISION` — whichever loaded second would silently win).
 *
 * Result order is dependency NAME order, never the config's declaration order:
 * the artifacts lead the file list, so declaration order would otherwise decide
 * what the loader sees first (see `test/order-independence.test.ts`).
 *
 * A project with no dependencies and no lock resolves to `[]` without touching
 * the filesystem — the byte-identical path.
 *
 * @param configDir absolute directory of the declaring config (the parent of
 *   `.metaobjects/`), which is where both the lock and the snapshot live.
 */
export async function verifySnapshot(
  configDir: string,
  specs: readonly DependencySpec[],
  lock: Lock | undefined,
): Promise<ResolvedDependency[]> {
  const declared = specs.map(dependencyName);

  if (lock === undefined) {
    // No dependencies AND no lock is the untouched project, not a stale one.
    if (declared.length === 0) return [];
    staleSnapshot(
      `${declared.length} dependenc${declared.length === 1 ? "y is" : "ies are"} declared ` +
        `(${declared.join(", ")}) but there is no ${DEFAULT_METAOBJECTS_DIR}/${LOCK_FILE}`,
    );
  }

  const entries = lock.dependencies;
  const declaredNames = new Set(declared);
  for (const name of Object.keys(entries)) {
    if (!declaredNames.has(name)) {
      staleSnapshot(
        `${DEFAULT_METAOBJECTS_DIR}/${LOCK_FILE} locks dependency "${name}", which ` +
          `${DEFAULT_METAOBJECTS_DIR}/config.json no longer declares`,
      );
    }
  }

  const resolved: ResolvedDependency[] = [];
  for (const name of [...declaredNames].sort()) {
    const entry = entries[name];
    if (entry === undefined) {
      staleSnapshot(
        `dependency "${name}" is declared but ${DEFAULT_METAOBJECTS_DIR}/${LOCK_FILE} has no entry for it`,
      );
    }

    const artifactPath = join(configDir, DEFAULT_METAOBJECTS_DIR, DEPS_DIR, name, entry.artifact);
    const bytes = await readFile(artifactPath).catch(() => undefined);
    if (bytes === undefined) {
      staleSnapshot(`the committed snapshot for "${name}" is missing (expected ${artifactPath})`);
    }
    const actual = sha256Integrity(bytes);
    if (actual !== entry.integrity) {
      staleSnapshot(
        `the committed snapshot for "${name}" does not match the lock — ${artifactPath} hashes ` +
          `to ${actual}, the lock records ${entry.integrity}`,
      );
    }

    if (metamodelMajor(entry.metamodelVersion) !== metamodelMajor(METAMODEL_VERSION)) {
      throw new ParseError(
        `dependency "${name}" was published against metamodel ${entry.metamodelVersion}; ` +
          `this toolchain speaks ${METAMODEL_VERSION}. A different metamodel MAJOR is a different ` +
          `metadata contract — upgrade the toolchain, or use a release of "${name}" built against it.`,
        { code: "ERR_DEPENDENCY_METAMODEL_INCOMPATIBLE", source: codeSource("verifySnapshot") },
      );
    }

    resolved.push({
      name,
      version: entry.version,
      packages: entry.packages,
      nodes: entry.nodes,
      artifactPath,
      sourceId: dependencySourceId(name, entry.artifact),
    });
  }

  // Collision is checked across the WHOLE resolved set rather than pairwise as
  // each is read, so the error names the two dependencies in name order however
  // the config declared them.
  const owner = new Map<string, string>();
  for (const dep of resolved) {
    for (const node of dep.nodes) {
      const prior = owner.get(node);
      if (prior !== undefined) {
        throw new ParseError(
          `dependencies "${prior}" and "${dep.name}" both export "${node}" — one fully-qualified ` +
            `node cannot come from two places, and whichever loaded second would silently win`,
          { code: "ERR_DEPENDENCY_NODE_COLLISION", source: codeSource("verifySnapshot") },
        );
      }
      owner.set(node, dep.name);
    }
  }

  return resolved;
}

/**
 * THE exclusion key (DESIGN §11.5, ruled 2026-09-11): every PACKAGE the
 * resolved dependencies own. A loaded node whose package is in here is
 * imported — load-only unless the consumer's own scope names that package.
 *
 * Package-keyed, not node-keyed: it is one concept rather than two, and it
 * matches the maintainer's own model ("everything loads into one tree, then you
 * include and exclude packages"). The one hole that opens — a local node
 * declared into a dependency's package silently never generating — is closed by
 * the refusal in `memory.ts`, which is the only reader of `importedNodesOf`.
 */
export function importedPackagesOf(deps: readonly ResolvedDependency[]): Set<string> {
  return new Set(deps.flatMap((d) => [...d.packages]));
}

/**
 * Every fully-qualified node the resolved dependencies export.
 *
 * Read by ONE caller: the `ERR_DEPENDENCY_PACKAGE_NOT_OWNED` refusal, which
 * needs it to tell a local OVERLAY of a dependency's node (its key is in here,
 * so it merges and passes) from a genuinely new local declaration in the
 * dependency's package (not in here, and refused). It is NOT the exclusion key
 * — see {@link importedPackagesOf}.
 */
export function importedNodesOf(deps: readonly ResolvedDependency[]): Set<string> {
  return new Set(deps.flatMap((d) => [...d.nodes]));
}

/**
 * Does some pattern in `patterns` name `pkg` LITERALLY (DESIGN §11.1 item 2)?
 *
 * Drop the pattern's final segment — which names the node — and what remains
 * must be wildcard-free and equal to `pkg`. So `acme::common::**` and
 * `acme::common::Address` both name `acme::common`; `acme::**` and `**` reach
 * its nodes but name nothing, and an absent or empty list names nothing.
 *
 * That asymmetry is the point. Imported metadata is load-only by default, and
 * the opt-in has to be an act of naming: a project that writes `scope.include:
 * ["**"]` to mean "all of MY model" must not thereby start generating, and
 * migrating, someone else's. Matching is therefore NOT `matchesScope` — a
 * pattern that MATCHES a package's nodes is a weaker statement than one that
 * NAMES the package.
 *
 * `packageOfResolutionKey` does the segment drop, so this and the resolution-key
 * grammar can never disagree about where a package ends. A `pkg` of `""` (a
 * root-level node, which a dependency artifact cannot contain — every top-level
 * node in one carries an explicit package) is never named: fail-closed.
 */
export function explicitlyIncludes(
  patterns: readonly string[] | undefined,
  pkg: string,
): boolean {
  if (patterns === undefined || pkg === "") return false;
  return patterns.some((pattern) => {
    const named = packageOfResolutionKey(pattern);
    return named !== "" && !named.includes("*") && named === pkg;
  });
}
