// FR-038 §8 — bind the orphan decision to the filesystem.
//
// reconcile-orphans.ts is deliberately pure: it answers "remove, refuse, or
// already gone?" from readers the caller supplies. This module supplies those
// readers, applies the answer, and keeps `.gen-state` honest afterwards. Keeping
// the two apart is what lets the RULE be tested without a filesystem and the
// PLUMBING be tested against real files, rather than only through a full runGen.
//
// Three properties this file is responsible for, none of which the pure decision
// can enforce on its own:
//
//   1. NAMESPACE SCOPE. A generator's `owns` predicate speaks in paths relative
//      to its own output directory; gen-state speaks in project-relative paths.
//      Translating between them is where a boundary is won or lost, so a path
//      that resolves outside the generator's directory is never even offered to
//      the predicate.
//   2. RECORD HYGIENE. A removed or already-gone path must be forgotten, or the
//      next run re-decides a settled orphan forever. A REFUSED path must be
//      kept, or a refusal degrades into permanent silence on the run after.
//   3. DRY-RUN HONESTY. `--dry-run` must report a pending deletion and perform
//      none, because a preview that hides a deletion is worse than no preview.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  listGeneratedPaths,
  isPristineGenerated,
  forgetGeneratedPaths,
} from "./overwrite-policy.js";
import { reconcileOrphans, type OrphanPolicy } from "./reconcile-orphans.js";

/** One opt-in generator's stake in the sweep. */
export interface OrphanJob {
  /** For diagnostics — which generator's namespace this is. */
  readonly generatorName: string;
  /** Absolute directory this generator wrote to, i.e. the base its policy's
   *  relative paths are measured from. */
  readonly writeOutDir: string;
  readonly policy: OrphanPolicy;
}

export interface SweepOrphansArgs {
  readonly genStateDir: string;
  /** Absolute project root — the base gen-state keys are relative to. */
  readonly projectRoot: string;
  /** Project-relative paths written on THIS run, by ANY generator. A path some
   *  other generator now produces is not an orphan, so the whole run's output is
   *  the right exclusion set, not just the opting-in generator's. */
  readonly emittedRelPaths: readonly string[];
  readonly jobs: readonly OrphanJob[];
  /** Decide and report, touch nothing. */
  readonly dryRun: boolean;
}

export interface SweepOrphansResult {
  /** Untouched orphans deleted (or, under dryRun, that would be). */
  readonly removed: string[];
  /** Hand-edited orphans left alone and reported. */
  readonly refused: string[];
  /** Which generator's namespace each refusal came from, so the caller can name it
   *  instead of assuming one. `orphanPolicy` is a generic `Generator` field and an app
   *  is encouraged to compose its own generator, so a message hardcoding one
   *  generator's name would be wrong for exactly the users the seam exists for. */
  readonly refusedBy: ReadonlyMap<string, string>;
  /** Hand-edited orphans deleted because their policy set `force`. Separate from
   *  `removed` so the caller can say the louder thing about them. */
  readonly forced: string[];
}

/** gen-state keys carry the platform separator; an `owns` predicate is written
 *  against generated output, which is always `/`-separated. Normalize once so a
 *  predicate authored the obvious way is not silently wrong off Linux. */
function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

export function sweepOrphans(args: SweepOrphansArgs): SweepOrphansResult {
  if (args.jobs.length === 0) {
    return { removed: [], refused: [], forced: [], refusedBy: new Map() };
  }

  const previouslyGenerated = listGeneratedPaths(args.genStateDir);
  if (previouslyGenerated.length === 0) {
    return { removed: [], refused: [], forced: [], refusedBy: new Map() };
  }

  // NOT normalized: both sides of this comparison are produced by
  // `relative(projectRoot, …)` — gen-state's keys and the runner's emitted paths
  // alike — so they already share whatever separator the platform uses.
  // Normalizing one side is what would break them apart. `toPosix` is used only
  // where a HUMAN-authored string is involved (the `owns` predicate below).
  const emitted = args.emittedRelPaths;
  // A path can fall inside two jobs' namespaces (an app may register several
  // requirementTests() instances). Sets keep the second visit from re-reporting
  // a file the first already dealt with.
  const removed = new Set<string>();
  const refused = new Set<string>();
  const forced = new Set<string>();
  const forget = new Set<string>();
  const refusedBy = new Map<string, string>();

  for (const job of args.jobs) {
    const decision = reconcileOrphans({
      previouslyGenerated,
      emitted,
      owns: (relPath) => {
        const inTarget = relative(job.writeOutDir, resolve(args.projectRoot, relPath));
        // "" is the directory itself; a `..` prefix or an absolute result means
        // the path is outside this generator's output entirely. Neither is
        // something the predicate should get a say in.
        if (inTarget === "" || inTarget.startsWith("..") || isAbsolute(inTarget)) {
          return false;
        }
        return job.policy.owns(toPosix(inTarget));
      },
      exists: (relPath) => existsSync(resolve(args.projectRoot, relPath)),
      // The committed hash manifest, NOT the snapshot body — the bodies are
      // gitignored, so on a fresh clone a body-based check could never prove a
      // file untouched and orphan cleanup would refuse everything forever.
      isUntouched: (relPath) => {
        const full = resolve(args.projectRoot, relPath);
        if (!existsSync(full)) return false;
        return isPristineGenerated(
          args.genStateDir,
          relPath,
          readFileSync(full, "utf-8"),
        );
      },
    });

    for (const relPath of decision.remove) {
      if (refused.has(relPath) || forced.has(relPath)) continue;
      removed.add(relPath);
      forget.add(relPath);
    }
    for (const relPath of decision.refused) {
      // `refused` belongs in this guard too. Without it, a path already refused by a
      // non-forcing job could be picked up by a later FORCING job whose namespace
      // overlaps (the file anticipates several requirementTests() instances), landing
      // in `refused` and `forced` at once — deleted from disk, while
      // `refusedOrphanMessage` tells the user it "was NOT deleted".
      //
      // First decision wins: a refusal is the conservative answer, and letting a
      // later job escalate it to a deletion would make the outcome depend on job
      // ORDER, which is exactly the ambiguity the runner's duplicate-path guard
      // exists to reject elsewhere.
      if (removed.has(relPath) || forced.has(relPath) || refused.has(relPath)) continue;
      if (job.policy.force === true) {
        forced.add(relPath);
        forget.add(relPath);
      } else {
        // Deliberately NOT forgotten: the record is what makes the refusal
        // repeat until someone resolves it.
        refused.add(relPath);
        refusedBy.set(relPath, job.generatorName);
      }
    }
    // Nothing on disk to report — the file is already gone. Clear the stale
    // record so this stops being reconsidered on every future run.
    for (const relPath of decision.vanished) forget.add(relPath);
  }

  if (!args.dryRun) {
    for (const relPath of [...removed, ...forced]) {
      rmSync(resolve(args.projectRoot, relPath), { force: true });
    }
    // Batched: the per-path form rewrites the whole manifest each call, so clearing
    // k orphans rewrote it k times for an identical result.
    forgetGeneratedPaths(args.genStateDir, forget);
  }

  return {
    removed: [...removed].sort(),
    refused: [...refused].sort(),
    forced: [...forced].sort(),
    refusedBy,
  };
}
