import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// Per the v0.3 AI-first metadata loading strategy: a package.meta.json is the
// boundary between metadata bundles. Three fields total — name, version,
// extends. No exports list; no @private. The package's metadata tree IS its
// public API. See docs/strategy/2026-05-12-v0.3-ai-first-metadata-loading.md
// §4.3.

/**
 * Validates a package version string. npm-compatible: semver basics
 * (major.minor.patch with optional prerelease/build). Not a full semver
 * parser — strict-enough for now.
 */
const VersionStringSchema = z.string().regex(
  /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/,
  "package version must follow semver (e.g. 1.2.0 or 1.2.0-alpha.1)",
);

/**
 * Validates a package extends entry. Either a bare package name or
 * a name with a semver range — npm-style. Range parsing is shallow
 * for v0.3 v0.1; full range resolution lands when multi-package
 * loading actually ships.
 */
const ExtendsEntrySchema = z.string().min(1);

/**
 * Validates a canonical metaobjects package ref: snake_case segments
 * separated by `::`. Examples: `mikes_website`, `acme::common::user_mgmt`.
 * Used in metadata file refs (extends:, super:) cross-language.
 */
const MetaobjectsPackageSchema = z.string().regex(
  /^[a-z][a-z0-9_]*(::[a-z][a-z0-9_]*)*$/,
  "metaobjectsPackage must be snake_case segments separated by :: (e.g. acme::common::user_mgmt)",
);

/**
 * The package.meta.json schema. Authoring this is the one-time cost of
 * defining a metadata package; subsequent edits should be rare.
 */
export const PackageManifestSchema = z.object({
  /**
   * Canonical name of the package in the language's native package manager.
   * Conventionally `@scope/name` (npm-style) for TS, but bare names also
   * work. Each language's package config (pom.xml, .csproj, pyproject.toml)
   * uses its own native field for this — only TS uses `name` here.
   */
  name: z.string().min(1),

  /** Semver version of this package. */
  version: VersionStringSchema,

  /**
   * Optional cross-language canonical ref for this package, used inside
   * metadata files (extends:, super:) and for cross-language consumption.
   * If omitted, derived from `name` via a simple rule: `@scope/name` →
   * `scope::name` (strip @, replace `/` with `::`). Hyphens stay as-is in
   * the auto-derived form — for hierarchical naming users declare this
   * field explicitly.
   *
   * Per v0.3 strategy doc §8.2.
   */
  metaobjectsPackage: MetaobjectsPackageSchema.optional(),

  /**
   * Other packages whose metadata trees this package extends. Each entry is
   * a package name; the loader resolves it to the matching peer package.
   * Empty/omitted means this package has no upstream dependencies.
   */
  extends: z.array(ExtendsEntrySchema).default([]),
});

export type PackageManifest = z.infer<typeof PackageManifestSchema>;

export const PACKAGE_MANIFEST_FILE = "package.meta.json";

/**
 * Read a package.meta.json from a given .meta/ root, if present.
 * Returns undefined when the file isn't there — packages are optional in
 * v0.3 v0.1 (loadMemory still works for single-package usage without one,
 * and forge init scaffolds one but doesn't enforce its presence).
 */
export async function readPackageManifest(metaDir: string): Promise<PackageManifest | undefined> {
  const path = join(metaDir, PACKAGE_MANIFEST_FILE);
  try {
    const s = await stat(path);
    if (!s.isFile()) return undefined;
  } catch {
    return undefined;
  }
  const raw = await readFile(path, "utf8");
  return PackageManifestSchema.parse(JSON.parse(raw));
}

/**
 * Return the canonical metaobjects package ref for a manifest. Uses the
 * explicit `metaobjectsPackage` field if set; otherwise derives from `name`
 * via the simple rule: `@scope/foo-bar` → `scope::foo-bar` (strip @,
 * replace `/` with `::`, leave hyphens). For hierarchical or non-trivial
 * naming users declare `metaobjectsPackage` explicitly.
 *
 * Returns undefined if `name` itself isn't a valid bare name (e.g. has
 * uppercase chars) and no explicit ref is set — the caller should treat
 * this as an authoring error.
 */
export function resolveMetaobjectsPackage(manifest: PackageManifest): string | undefined {
  if (manifest.metaobjectsPackage !== undefined) return manifest.metaobjectsPackage;
  // Auto-derive from name: strip leading @, replace / with ::, lowercase
  // remains untouched — npm names are already lowercase per registry rules.
  const stripped = manifest.name.replace(/^@/, "");
  const derived = stripped.replace(/\//g, "::");
  // Validate that the derived form is a legal canonical ref. If not,
  // return undefined so the caller can surface a clear error.
  if (!/^[a-z][a-z0-9_-]*(::[a-z][a-z0-9_-]*)*$/.test(derived)) {
    return undefined;
  }
  return derived;
}
