// server/typescript/packages/sdk/src/dependencies.ts
//
// FR-023 — metadata dependencies: the `dependencies` key of
// `.metaobjects/config.json` (DESIGN §3.1), the manifest/lock schemas and
// integrity hashing (DESIGN §3.2, §3.3, minus `mode` — DESIGN §11.1/§11.3),
// and the constants every later task shares. This module carries the
// schemas and helpers only — the collection resolver that actually folds a
// dependency's artifact into the loaded tree (`verifySnapshot`, exclusion by
// `packages`) lands in a later task.
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
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
 * shared shape of `packages` and `nodes` on both {@link ManifestSchema} and
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
 * `.strict()`: an unknown key — in particular a resurrected `mode` (FR-023
 * §11.3, removed by Task 6 and not reintroduced) — is a hard parse error
 * rather than one zod silently strips.
 */
export const ManifestSchema = z
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

export type Manifest = z.infer<typeof ManifestSchema>;

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
