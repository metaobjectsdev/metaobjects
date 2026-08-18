// FR-038 §8 — deletion integrity: what happens to a generated file that is no
// longer generated.
//
// A requirement's stubs become orphans when the requirement is deleted. The
// obvious move — remove them, as the FR-038 draft said for `abandoned` entries —
// is safe only for an UNTOUCHED stub. On a filled one it eats assertions somebody
// wrote, and the whole point of the inversion is that the body is hand-written and
// survives regeneration.
//
// So: remove what the generator wrote, REFUSE what a human changed, and name it.
// That mirrors the migrate engine refusing a primary-key move rather than emitting
// something un-appliable (#258) — a refusal is recoverable, a deletion is not.
//
// Deliberately PURE: the caller supplies the readers. The decision is the part
// worth testing, and threading a filesystem through it would make the rule harder
// to exercise than the plumbing around it.

/**
 * A generator's opt-in to orphan reconciliation, and the namespace it applies to.
 *
 * Declaring this is the ONLY way in: `.gen-state/.hashes.json` records paths, not
 * which generator produced each one, so the runner genuinely cannot work out who
 * owns what. Deriving ownership from the output directory instead would be worse
 * than useless — every generator in a single-target project writes to the same
 * `outDir`, so one generator narrowing its output would delete its siblings'
 * files. The generator has to say.
 */
export interface OrphanPolicy {
  /**
   * True when `relPathInTarget` — a path relative to this generator's own output
   * directory, always `/`-separated — is inside the namespace this generator is
   * the sole producer of.
   *
   * Be narrow. This predicate is the blast radius: every previously-generated
   * path it accepts and this run did not re-emit is a deletion candidate.
   */
  readonly owns: (relPathInTarget: string) => boolean;
  /**
   * Delete a hand-edited orphan instead of refusing it. Default false.
   *
   * The seam exists because §6 requires every default to have one, not because
   * it is advisable: the refusal already names the file and deleting it by hand
   * is a one-line answer, whereas this flag makes the destructive outcome the
   * automatic one.
   */
  readonly force?: boolean;
}

export interface OrphanDecision {
  /** No longer emitted, on disk, and byte-identical to the snapshot we wrote.
   *  Safe to delete — the generator is removing only its own untouched output. */
  readonly remove: readonly string[];
  /** No longer emitted and CHANGED since we wrote it (or with no snapshot to
   *  compare against). Left alone and reported, never deleted. */
  readonly refused: readonly string[];
  /** No longer emitted and already absent from disk. Nothing to delete; the
   *  caller should just drop the stale snapshot. */
  readonly vanished: readonly string[];
}

export interface ReconcileOrphansArgs {
  /** Relative paths this generator emitted on some previous run — in practice the
   *  keys of `.gen-state/.hashes.json`. */
  readonly previouslyGenerated: readonly string[];
  /** Relative paths emitted on THIS run. */
  readonly emitted: readonly string[];
  /** Namespace guard. Orphan reconciliation is opt-in and scoped: a generator must
   *  never delete another generator's output just because it stopped emitting its
   *  own. */
  readonly owns: (relPath: string) => boolean;
  /** Whether the file is still on disk at all. */
  readonly exists: (relPath: string) => boolean;
  /**
   * Whether the file is byte-for-byte what we recorded writing.
   *
   * MUST fail closed — false when it cannot be proven. This is deliberately the
   * same question the write path asks (`isPristineGenerated`), of the same
   * evidence: the committed hash manifest. Before they were unified, one feature
   * refused to DELETE a hand-edited file while silently OVERWRITING one, which is
   * the same uncertainty answered two opposite ways.
   */
  readonly isUntouched: (relPath: string) => boolean;
}

export function reconcileOrphans(args: ReconcileOrphansArgs): OrphanDecision {
  const emitted = new Set(args.emitted);
  const remove: string[] = [];
  const refused: string[] = [];
  const vanished: string[] = [];

  for (const relPath of args.previouslyGenerated) {
    if (emitted.has(relPath)) continue;
    if (!args.owns(relPath)) continue;

    if (!args.exists(relPath)) {
      vanished.push(relPath);
      continue;
    }

    // Fail closed: unless we can prove the file is untouched, guessing wrong
    // deletes someone's work.
    if (!args.isUntouched(relPath)) {
      refused.push(relPath);
      continue;
    }

    remove.push(relPath);
  }

  return { remove, refused, vanished };
}

/**
 * The message shown when a hand-edited orphan is refused.
 *
 * It has to say what happened, why nothing was deleted, and what the two ways out
 * are — otherwise the reasonable reaction to an unexplained refusal is to delete
 * the file, which is the outcome the refusal exists to prevent.
 */
export function refusedOrphanMessage(
  paths: readonly string[],
  /** Which generator's namespace these came from. `orphanPolicy` is a generic
   *  `Generator` field and `sweepOrphans`/`OrphanPolicy` are exported precisely so an
   *  app can compose its own — so this message must not hardcode `requirement-tests`,
   *  naming a generator the project may not even use and a cause ("the requirement was
   *  removed") that may not apply. */
  generatorName = "orphan cleanup",
): string {
  return (
    `${generatorName}: ${paths.length} generated file(s) are no longer produced by ` +
    `this generator but have been edited by hand, so they were NOT deleted: ` +
    `${paths.join(", ")}. Either what produced them was removed (delete these files ` +
    `yourself if the edits are no longer wanted) or it was renamed (move the edits ` +
    `into the newly generated file first — regeneration cannot follow a rename).`
  );
}
