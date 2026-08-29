import { createHash } from "node:crypto";
import type { AssembledFile, Stack } from "./types.js";

/** Consumer-relative path of the sidecar manifest that tracks scaffolded files. */
export const AGENT_CONTEXT_MANIFEST_PATH = ".metaobjects/.agent-context.json";

export interface Manifest {
  version: 1;
  /**
   * The MetaObjects version that last scaffolded this agent context. Used to nudge
   * a re-scaffold when the installed version moves ahead (the skills/docs ship with
   * the package, so an upgrade can leave the copied-in context stale). Optional for
   * back-compat with manifests written before version tracking existed.
   */
  generatedBy?: string;
  servers: string[];
  clients: string[];
  /** consumer-relative path → sha256 of the contents as last scaffolded. */
  files: Record<string, string>;
}

export function hashContents(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export interface ScaffoldDecision {
  /** files to (over)write at their own path: new, or unmodified-since-last-scaffold. */
  writes: { path: string; contents: string }[];
  /** hand-edited files: write the fresh contents to `<path>.new`, leave the original. */
  conflicts: { path: string; newPath: string; contents: string }[];
  /** the manifest to persist after writing. */
  manifest: Manifest;
  /** paths the prior manifest tracked that are no longer assembled (e.g. stack shrank) — reported, never auto-deleted. */
  removed: string[];
}

/**
 * Decide what to write for a (re-)scaffold. Pure: filesystem access is via the
 * `readCurrent` callback (returns the on-disk contents, or undefined if absent).
 * A file is safe to overwrite iff it is absent, or its on-disk hash still equals
 * the hash the prior manifest recorded (i.e. the user hasn't hand-edited it).
 */
export function planScaffold(opts: {
  stack: Stack;
  assembled: AssembledFile[];
  prior: Manifest | undefined;
  readCurrent: (path: string) => string | undefined;
  /** The MetaObjects version doing the scaffold — stamped into the manifest. */
  generatedBy: string;
}): ScaffoldDecision {
  const { stack, assembled, prior, readCurrent, generatedBy } = opts;
  const writes: ScaffoldDecision["writes"] = [];
  const conflicts: ScaffoldDecision["conflicts"] = [];
  const files: Record<string, string> = {};

  for (const f of assembled) {
    files[f.path] = hashContents(f.contents);
    const current = readCurrent(f.path);
    if (current === undefined) {
      writes.push({ path: f.path, contents: f.contents });
      continue;
    }
    const priorHash = prior?.files[f.path];
    if (priorHash !== undefined && hashContents(current) === priorHash) {
      writes.push({ path: f.path, contents: f.contents }); // unmodified → refresh to latest
    } else {
      conflicts.push({ path: f.path, newPath: `${f.path}.new`, contents: f.contents });
    }
  }

  const assembledPaths = new Set(assembled.map((f) => f.path));
  const removed = prior ? Object.keys(prior.files).filter((p) => !assembledPaths.has(p)) : [];

  return {
    writes,
    conflicts,
    manifest: { version: 1, generatedBy, servers: stack.servers, clients: stack.clients, files },
    removed,
  };
}

/**
 * The ordered release coordinate of a version — `[minor, patch]` — or `null` when the
 * version cannot be ordered as a plain release.
 *
 * The MAJOR is deliberately dropped. It is a per-registry constant, not information:
 * npm/PyPI/NuGet ship `0.<m>.<p>` and Maven Central the same `<m>.<p>` on its historical
 * major `7`, so the minor.patch IS the shared release coordinate across all four (this is
 * the same reduction the JVM's `releaseCoordinate` has always made for equality).
 *
 * Returns `null` — meaning "not orderable, so nudge" — for anything that is not exactly
 * three dot-separated integers. That deliberately covers prereleases (`0.24.5-rc.1`),
 * build metadata (`0.24.5+abc`), and the `0.0.0` sentinel a port emits when it cannot
 * resolve its own installed version. Each must keep nudging: an RC-scaffolded context
 * against a final release is still worth refreshing, and an unknown install must never
 * be allowed to assert "in sync".
 */
function releaseSeries(version: string | undefined): [number, number] | null {
  if (version === undefined) return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (m === null) return null;
  if (version.trim() === UNRESOLVED_VERSION) return null; // never assert in-sync on unknown
  return [Number(m[2]), Number(m[3])];
}

/** The sentinel a port stamps when it cannot resolve its own installed version. */
const UNRESOLVED_VERSION = "0.0.0";

/**
 * True when the manifest was stamped by a release STRICTLY NEWER than the installed one.
 *
 * This is the one exemption from "any drift nudges", and it exists because of the
 * publish-what-changed rule (docs/RELEASING.md): a registry publishes only when it has a
 * changed product file, so a port legitimately sits behind npm — while `meta agent-docs`,
 * the canonical scaffolder for EVERY port, stamps the npm version it was run from. A
 * Python install at `0.24.4` whose context was scaffolded by npm `0.24.7` is correct, and
 * nudging it is [#347](https://github.com/metaobjectsdev/metaobjects/issues/347) exactly:
 * the remedy re-runs the scaffolder, which re-stamps `0.24.7`, so the advisory can never
 * be satisfied and fires on every build forever. An advisory that cries wolf in the inner
 * loop gets tuned out, and then it is not there for the upgrade it exists for.
 *
 * KNOWN BOUND, stated rather than hidden: ordering on minor.patch assumes both versions
 * sit in the same release SERIES. That holds for every release to date and for every
 * release after the 1.0/8.0 cut, but not ACROSS it — at that one cut a `0.24.x`-stamped
 * context against a `1.0.0` install compares (24,x) > (0,0) and is read as "ahead", so the
 * nudge is suppressed once when it should fire. The cost is a missed advisory, never a
 * wrong action, and re-scaffolding at 1.0 is part of the cut anyway.
 */
function contextIsAheadOfInstall(generatedBy: string | undefined, currentVersion: string): boolean {
  const stamped = releaseSeries(generatedBy);
  const installed = releaseSeries(currentVersion);
  if (stamped === null || installed === null) return false; // not orderable → nudge
  return stamped[0] > installed[0] || (stamped[0] === installed[0] && stamped[1] > installed[1]);
}

/**
 * A one-line nudge if the scaffolded agent context predates the installed MetaObjects
 * (so `gen`/`verify` can remind the user to refresh the skills after an upgrade), or
 * `null` when there is nothing to say — no agent context scaffolded, or it is in sync.
 * Advisory only: never throws, never blocks, never writes.
 */
export function agentContextStaleness(opts: {
  manifest: Manifest | undefined;
  currentVersion: string;
}): string | null {
  const { manifest, currentVersion } = opts;
  if (manifest === undefined) return null; // no agent context here → nothing to nudge
  // Exact-equality FIRST: ANY drift nudges (a re-scaffold is cheap + idempotent). A
  // prerelease/build-metadata difference is still a reason to refresh, so this is not a
  // semver compare — see releaseSeries() for the ONE case that is exempt.
  if (manifest.generatedBy === currentVersion) return null; // in sync
  if (contextIsAheadOfInstall(manifest.generatedBy, currentVersion)) return null;
  const from = manifest.generatedBy ?? "an older MetaObjects";
  return (
    `MetaObjects agent context was generated by ${from}; you're on ${currentVersion}. ` +
    `Re-run 'meta init --docs-only --refresh-docs' to refresh the .claude/skills docs.`
  );
}
