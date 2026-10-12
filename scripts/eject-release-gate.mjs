#!/usr/bin/env node
/**
 * The eject release gate (ADR-0034 Amendment 8): a FINAL version is not released while the
 * eject contract's pending list has entries.
 *
 *   node scripts/eject-release-gate.mjs 1.1.0        # exit 1 and say why, or exit 0
 *   import { ejectReleaseRefusal } from "./eject-release-gate.mjs"
 *
 * `fixtures/generator-registry-conformance/registry.json` lists, under `eject.pending`,
 * every place a stock generator's owned copy does not yet hold its emit. Each port's
 * eject-contract test passes with entries in that list, which is what lets work land one
 * gap at a time. It is also what would let a release go out with gaps left, so every path
 * that publishes or tags asks here before it does anything irreversible:
 *
 *   - `scripts/release.mjs`, in its preflight, before the version bump and the first publish.
 *   - `scripts/finish-release.mjs`, before it cuts `v<version>`. Every final release ends
 *     there, including one where npm sat out and `release.mjs` never ran.
 *   - the four publish workflows (`.github/workflows/publish-*.yml`), as the step after
 *     checkout, with the version that workflow is about to publish.
 *
 * A prerelease (`1.1.0-rc.3`) is allowed with entries left: a release candidate is how the
 * remaining work is tried against an adopter. A version with no prerelease suffix is refused
 * while an entry remains, and when the list cannot be read.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The shared file, relative to the repository root. */
export const EJECT_MANIFEST = "fixtures/generator-registry-conformance/registry.json";

/**
 * @typedef {{generator: string, port: string, assertion: string, gap: number}} PendingEntry
 * @typedef {{eject?: {pending?: PendingEntry[]}}} EjectManifest
 */

/** True for a version with a prerelease suffix (`1.1.0-rc.3`), which the gate lets through. */
/** @type {(version: string) => boolean} */
export const isPrerelease = (version) => version.includes("-");

/**
 * Why `version` may not be released, or `null` when it may.
 *
 * @param {string} version
 * @param {EjectManifest} manifest the parsed shared file
 * @returns {string | null}
 */
export function ejectReleaseRefusal(version, manifest) {
  if (isPrerelease(version)) return null;
  const pending = manifest.eject?.pending;
  if (!Array.isArray(pending)) {
    // Fail closed. A file this gate cannot read is not evidence that nothing is pending.
    return `${EJECT_MANIFEST} has no readable eject.pending list, ` +
      `so ${version} cannot be shown to meet the eject contract`;
  }
  if (pending.length === 0) return null;

  const byPort = new Map();
  for (const entry of pending) byPort.set(entry.port, (byPort.get(entry.port) ?? 0) + 1);
  const counts = [...byPort].sort(([a], [b]) => a.localeCompare(b)).map(([port, n]) => `${port} ${n}`).join(", ");
  return [
    `${version} is a final release, and the eject contract does not hold yet (ADR-0034 Amendment 8).`,
    `  ${pending.length} entr${pending.length === 1 ? "y is" : "ies are"} left in eject.pending of ${EJECT_MANIFEST}: ${counts}.`,
    "  Close each gap and delete its entry; a port's eject-contract test names what is left.",
    "  A release candidate (a version with a prerelease suffix, e.g. -rc.1) is not refused.",
  ].join("\n");
}

/**
 * {@link ejectReleaseRefusal} over the shared file of the repository at `root`.
 *
 * @param {string} version
 * @param {string} root the repository root
 * @returns {string | null}
 */
export function ejectReleaseRefusalAt(version, root) {
  if (isPrerelease(version)) return null;
  const file = join(root, EJECT_MANIFEST);
  if (!existsSync(file)) return `${EJECT_MANIFEST} is missing, so ${version} cannot be shown to meet the eject contract`;
  /** @type {EjectManifest} */
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return `${EJECT_MANIFEST} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
  }
  return ejectReleaseRefusal(version, manifest);
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2];
  if (version === undefined || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    console.error("usage: node scripts/eject-release-gate.mjs <version>   (e.g. 1.1.0, or 1.1.0-rc.3)");
    process.exit(2);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const refusal = ejectReleaseRefusalAt(version, root);
  if (refusal !== null) {
    console.error(`\x1b[31m✗\x1b[0m ${refusal}`);
    process.exit(1);
  }
  console.log(`\x1b[32m✓\x1b[0m eject contract: ${version} may be released`);
}
