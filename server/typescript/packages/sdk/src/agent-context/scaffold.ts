import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { AssembledFile, Stack } from "./types.js";
import { docsBlobUrl, docsRefForVersion } from "@metaobjectsdev/metadata";

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
  /**
   * Hash of the agent-context content the scaffolding CLI shipped (see
   * {@link hashAgentContextRoot}). The staleness check compares THIS, so a content change
   * shipped without a version change is noticed, and a version change that changed no
   * content is not a reason to nudge. Optional: manifests written before it fall back to
   * comparing `generatedBy`.
   */
  contentHash?: string;
  servers: string[];
  clients: string[];
  /** consumer-relative path → sha256 of the contents as last scaffolded. */
  files: Record<string, string>;
}

export function hashContents(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * A stable hash of the agent-context content tree a release ships, plus the docs ref its
 * links are pinned to (the scaffolded text embeds it, so a different ref is different
 * content). Independent of the project's stack and of directory order.
 */
export function hashAgentContextRoot(root: string, docsRef: string): string {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else entries.push(`${relative(root, abs).split(sep).join("/")}\0${hashContents(readFileSync(abs, "utf8"))}`);
    }
  };
  walk(root);
  return hashContents(`${docsRef}\n${entries.sort().join("\n")}`);
}

export interface ScaffoldDecision {
  /** files to (over)write at their own path: new, or unmodified-since-last-scaffold. */
  writes: { path: string; contents: string }[];
  /** hand-edited files: write the fresh contents to `<path>.new`, leave the original. */
  conflicts: { path: string; newPath: string; contents: string }[];
  /** the manifest to persist after writing. */
  manifest: Manifest;
  /**
   * Orphans safe to DELETE: the prior manifest tracked them, this stack no longer
   * assembles them, and the on-disk content still hashes to what we recorded writing.
   *
   * Same predicate that separates `writes` from `conflicts` — we only ever remove a file
   * we wrote and nobody has touched, so deleting is exactly as safe as the overwrite that
   * predicate already authorises for a file still in the stack.
   */
  prunes: string[];
  /**
   * Orphans that are HAND-EDITED — reported, never auto-deleted. Losing an adopter's
   * writing is worse than leaving a stale file behind.
   *
   * An orphan already absent from disk appears in neither list: there is nothing to delete
   * and nothing to report. It simply leaves the manifest.
   */
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
  /** {@link hashAgentContextRoot} of the content being scaffolded — stamped into the manifest. */
  contentHash?: string;
}): ScaffoldDecision {
  const { stack, assembled, prior, readCurrent, generatedBy, contentHash } = opts;
  const writes: ScaffoldDecision["writes"] = [];
  const conflicts: ScaffoldDecision["conflicts"] = [];
  const files: Record<string, string> = {};

  // The manifest records what we WROTE, never what we merely produced. It used to be
  // stamped with `hashContents(f.contents)` for every assembled file, before the write /
  // decline decision — so a DECLINED path (contents parked in `<path>.new`, original left
  // alone by design) was recorded with the hash of the file that was not written. That hash
  // matched neither the disk nor anything this tool had ever written: pure fiction in the
  // one record that exists to tell "still exactly what we scaffolded" from "hand-edited",
  // sitting under a `generatedBy` asserting the context was current at this version while
  // the file on disk was the predecessor's text.
  //
  // A declined path keeps the PRIOR hash — what we last actually wrote — so the comparison
  // stays meaningful: revert the hand edit and the next refresh sees an unmodified file and
  // refreshes it. A declined path we have never written (a file that was already there,
  // unmanaged) gets no entry at all, because there is no true value to record.
  for (const f of assembled) {
    const current = readCurrent(f.path);
    if (current === undefined) {
      files[f.path] = hashContents(f.contents);
      writes.push({ path: f.path, contents: f.contents });
      continue;
    }
    const priorHash = prior?.files[f.path];
    if (priorHash !== undefined && hashContents(current) === priorHash) {
      files[f.path] = hashContents(f.contents);
      writes.push({ path: f.path, contents: f.contents }); // unmodified → refresh to latest
    } else {
      if (priorHash !== undefined) files[f.path] = priorHash;
      conflicts.push({ path: f.path, newPath: `${f.path}.new`, contents: f.contents });
    }
  }

  // An orphan is a path the prior manifest tracked that this stack no longer assembles —
  // typically a language fragment left by `--refresh-docs --server <other>`. It used to be
  // reported and never deleted whatever its state, so a python.md sat in a TypeScript
  // project forever while every SKILL.md footer told the reader to read every
  // references/*.md "one per server language in this project's stack".
  const assembledPaths = new Set(assembled.map((f) => f.path));
  const prunes: string[] = [];
  const removed: string[] = [];
  for (const path of prior ? Object.keys(prior.files) : []) {
    if (assembledPaths.has(path)) continue;
    const current = readCurrent(path);
    if (current === undefined) continue;                       // already gone — nothing to do
    if (hashContents(current) === prior?.files[path]) prunes.push(path);
    else removed.push(path);
  }

  return {
    writes,
    conflicts,
    // `files` holds only what this run assembled, so a pruned orphan does not survive into
    // the new manifest — otherwise it would be re-reported as an orphan on every run.
    manifest: { version: 1, generatedBy, ...(contentHash !== undefined && { contentHash }), servers: stack.servers, clients: stack.clients, files },
    prunes,
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
 * One row per minor (or major) step that has an upgrade guide. `from` and `to` are
 * `major.minor` lines; `path` is repo-relative. Adding the next step's guide is one row
 * here, nothing else. A patch-level step needs no row: its guide is the within-line one
 * the always-on context already names.
 */
export const MINOR_STEP_GUIDES: readonly { from: string; to: string; path: string }[] = [
  { from: "1.0", to: "1.1", path: "docs/features/migrations/upgrading-1.0-to-1.1.md" },
];

function releaseLine(version: string | undefined): [number, number] | null {
  if (version === undefined) return null;
  const m = /^(\d+)\.(\d+)\./.exec(version.trim());
  return m === null ? null : [Number(m[1]), Number(m[2])];
}

function lineAtMost(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]);
}

/**
 * The guides for every minor/major step between the stamped version and the installed
 * one: a step counts when it starts at or after the stamped line and ends at or before the
 * installed line. Empty for a patch-level difference or a version that cannot be read.
 */
function minorStepGuides(generatedBy: string | undefined, currentVersion: string): string[] {
  const stamped = releaseLine(generatedBy);
  const installed = releaseLine(currentVersion);
  if (stamped === null || installed === null) return [];
  const ref = docsRefForVersion(currentVersion);
  const out: string[] = [];
  for (const g of MINOR_STEP_GUIDES) {
    const from = releaseLine(`${g.from}.`);
    const to = releaseLine(`${g.to}.`);
    if (from === null || to === null) continue;
    if (lineAtMost(stamped, from) && lineAtMost(to, installed)) out.push(`${g.from} to ${g.to}: ${docsBlobUrl(g.path, ref)}`);
  }
  return out;
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
  /** {@link hashAgentContextRoot} of the installed content; when given and the manifest
   *  carries one, the two hashes decide instead of the versions. */
  currentContentHash?: string;
}): string | null {
  const { manifest, currentVersion, currentContentHash } = opts;
  if (manifest === undefined) return null; // no agent context here → nothing to nudge
  // Exact-equality FIRST: ANY drift nudges (a re-scaffold is cheap + idempotent). A
  // prerelease/build-metadata difference is still a reason to refresh, so this is not a
  // semver compare — see releaseSeries() for the ONE case that is exempt.
  const hashed = manifest.contentHash !== undefined && currentContentHash !== undefined;
  // The shipped content decides when both sides recorded it: equal content has nothing to
  // refresh whatever the versions say (and a content change that rode on an unchanged version
  // is no longer missed).
  if (hashed && manifest.contentHash === currentContentHash) return null;
  if (!hashed && manifest.generatedBy === currentVersion) return null; // in sync
  if (contextIsAheadOfInstall(manifest.generatedBy, currentVersion)) return null;
  const from = manifest.generatedBy ?? "an older MetaObjects";
  const guides = minorStepGuides(manifest.generatedBy, currentVersion);
  return (
    `MetaObjects agent context was generated by ${from}; you're on ${currentVersion}. ` +
    `Re-run 'meta init --docs-only --refresh-docs' to refresh the .claude/skills docs.` +
    (guides.length > 0 ? ` This is a minor upgrade: read the upgrade guide first (${guides.join("; ")}).` : "")
  );
}
