// server/typescript/packages/sdk/src/dependencies.ts
//
// FR-023 — metadata dependencies: the `dependencies` key of
// `.metaobjects/config.json` (DESIGN §3.1) plus the constants every later
// task (manifest, lock, snapshot, sync) shares. This module carries the
// schema and the constants only — resolving a declared dependency to bytes
// on disk, the manifest, the lock and the sync command land in later tasks.
import { z } from "zod";

/** Directory (under `.metaobjects/`) holding the synced snapshot artifacts,
 *  one subdirectory per dependency name: `.metaobjects/deps/<name>/`. */
export const DEPS_DIR = "deps";

/** `meta deps sync`'s output — the only writer (DESIGN §3.3). */
export const LOCK_FILE = "deps.lock.json";

/** D10 co-development override — never committed (DESIGN §10 D10). */
export const LOCAL_OVERRIDE_FILE = "deps.local.json";

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

/** The two modes a declared dependency may run in (DESIGN §2.4, §2.7). */
export const DEPENDENCY_MODES = ["reference", "own"] as const;

/** `mode`'s default when a dependency spec omits it. */
export const DEFAULT_DEPENDENCY_MODE: (typeof DEPENDENCY_MODES)[number] = "reference";

export type DependencyMode = (typeof DEPENDENCY_MODES)[number];

/**
 * A declared dependency: a `name`, exactly one transport (`path` | `npm` |
 * `python`), and a `mode`. `npm`/`python` optionally carry `dir` — the
 * subdirectory under the resolved package holding `metaobjects.pkg.json`;
 * `path` never does, since the path itself already names that directory.
 *
 * Mirrors the hand-written union below in `DependencySpecSchema` — the same
 * two-direction parity guard `SourceSpec`/`SourceSpecSchema` carries (see
 * `config.ts`), so the schema and this type cannot silently drift.
 */
export type DependencySpec = { readonly name: string; readonly mode: DependencyMode } & (
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

const Mode = z.enum(DEPENDENCY_MODES).default(DEFAULT_DEPENDENCY_MODE);

/**
 * `.strict()` on every arm, same rationale as `SourceSpecSchema` in
 * `config.ts`: a config schema that silently strips an unknown key would let
 * `{ name: "a", path: "x", pathh: "typo" }` parse clean instead of erroring
 * on the typo. A `z.union` (rather than a discriminated union) because the
 * three arms share no single literal discriminator key — the transport key
 * itself (`path`/`npm`/`python`) is what distinguishes them, and that is
 * exactly what the "two transports in one spec" / "no transport" refusals
 * below exercise: neither shape matches any arm, so the union fails closed.
 */
export const DependencySpecSchema = z.union([
  z.object({ name: DependencyName, path: z.string().min(1), mode: Mode }).strict(),
  z.object({ name: DependencyName, npm: z.string().min(1), dir: z.string().min(1).optional(), mode: Mode }).strict(),
  z.object({ name: DependencyName, python: z.string().min(1), dir: z.string().min(1).optional(), mode: Mode }).strict(),
]);

/** The declared name of a dependency spec — `name` is common to all three
 *  transport arms, so this needs no narrowing. Exists so callers never
 *  inline `.name` and so later tasks (manifest/lock keying) have one place
 *  this projection is defined. */
export function dependencyName(spec: DependencySpec): string {
  return spec.name;
}
