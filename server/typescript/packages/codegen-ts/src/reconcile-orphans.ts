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
  /** Current on-disk content, or undefined when the file is gone. */
  readonly readCurrent: (relPath: string) => string | undefined;
  /** The `.gen-state` snapshot of what we last wrote, or undefined when absent. */
  readonly readSnapshot: (relPath: string) => string | undefined;
}

export function reconcileOrphans(args: ReconcileOrphansArgs): OrphanDecision {
  const emitted = new Set(args.emitted);
  const remove: string[] = [];
  const refused: string[] = [];
  const vanished: string[] = [];

  for (const relPath of args.previouslyGenerated) {
    if (emitted.has(relPath)) continue;
    if (!args.owns(relPath)) continue;

    const current = args.readCurrent(relPath);
    if (current === undefined) {
      vanished.push(relPath);
      continue;
    }

    // Fail closed on a missing snapshot: with no baseline we cannot prove the file
    // is untouched, and guessing wrong deletes someone's work.
    const snapshot = args.readSnapshot(relPath);
    if (snapshot === undefined || current !== snapshot) {
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
export function refusedOrphanMessage(paths: readonly string[]): string {
  return (
    `requirement-tests: ${paths.length} generated file(s) are no longer produced by ` +
    `any requirement but have been edited by hand, so they were NOT deleted: ` +
    `${paths.join(", ")}. Either the requirement was removed (delete these files ` +
    `yourself if the assertions are no longer wanted) or it was renamed (move the ` +
    `assertions into the newly generated stub first — regeneration cannot follow a ` +
    `rename).`
  );
}
