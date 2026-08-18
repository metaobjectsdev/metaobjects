// What `meta migrate` and `meta verify --db` SAY about a declared `migrate.scope`.
//
// The scope itself needs no adapter: `resolveCollection` hands back
// `inMigrateScope` already in migrate-ts's predicate shape, so the pattern grammar
// lives in exactly one place (`matchesScope`, @metaobjectsdev/sdk) and `migrate` and
// `gen` cannot come to disagree about what `acme::platform::**` means.
//
// What DOES need one home is the user-facing language, and both commands import it
// from here: they govern the identical object set from one declaration, so a note
// or a refusal that drifted between them would be drift the user reads.

import type { Collection } from "@metaobjectsdev/sdk";
import type { MetaRoot } from "@metaobjectsdev/metadata";

/**
 * Say what a declared `migrate.scope` left out, for `migrate` and `verify --db`
 * alike.
 *
 * An excluded object produces neither a create nor a drop and is neither checked
 * nor reported as drift, so without this line "no changes" and "no changes to the
 * half of the model this run governs" read identically — and an unchecked table is
 * indistinguishable from a checked-and-clean one.
 *
 * One sentence, one definition: the two commands say the same thing about the same
 * declaration, and this is a string a user reads, so drift between two copies of it
 * is drift the user sees.
 */
export function outOfScopeNote(command: string, names: readonly string[]): string {
  return (
    `meta ${command} — ${names.length} object(s) out-of-scope ` +
    `(outside migrate.scope, governed elsewhere): ${names.join(", ")}`
  );
}

/** How many loaded FQNs to name in the refusal below — enough to show the shape
 *  an author's patterns have to match, short enough to stay readable. */
const EXAMPLE_FQN_CAP = 3;

/**
 * The refusal for a `migrate.scope` that matches NOTHING.
 *
 * A scope matching zero loaded objects can never be what someone meant — it says
 * "every table in this model belongs to somebody else", which is a project with no
 * schema to migrate at all, expressed the hard way. In practice it is a typo'd or
 * stale package pattern, and it is silent: migrate reports "no changes" while
 * having compared nothing.
 *
 * It is also actively dangerous, which is why this is a refusal and not a warning.
 * An empty expected side is what `diff` reads as "no model, govern the whole
 * database" — the inversion `scopeExpectedSchema`'s `declaredSchemas` closes
 * structurally (migrate-ts `scope.ts`). This is the second lock on the same door:
 * the structural fix stops a wrong scope proposing a destructive change, and this
 * stops the wrong scope going unnoticed in the first place.
 *
 * Returns the message to report, or `undefined` when there is nothing to refuse —
 * no scope declared, or at least one loaded object inside it. Callers report it and
 * exit 2 (a configuration error), rather than this throwing, so it reads like every
 * other config failure in these commands.
 */
export function migrateScopeMismatch(
  collection: Collection,
  root: MetaRoot,
): string | undefined {
  const { inMigrateScope, migrateScopePatterns } = collection;
  if (inMigrateScope === undefined) return undefined;

  // ADR-0039: `objects()` is the resolving accessor — the loaded object set, which
  // is exactly what `migrate.scope` claims to be a subset of.
  const fqns = root.objects().map((o) => o.resolutionKey());
  // No objects at all is not a scope error: there is nothing for a pattern to miss,
  // and an empty model has its own (much louder) failure modes downstream.
  if (fqns.length === 0) return undefined;
  if (fqns.some(inMigrateScope)) return undefined;

  const patterns = JSON.stringify(migrateScopePatterns ?? []);
  const examples = fqns.slice(0, EXAMPLE_FQN_CAP).join(", ");
  const more = fqns.length > EXAMPLE_FQN_CAP ? `, …and ${fqns.length - EXAMPLE_FQN_CAP} more` : "";
  return (
    `migrate.scope matched none of the ${fqns.length} object(s) loaded, so this run would ` +
    `treat every one of them as another owner's and compare nothing. ` +
    `Patterns: ${patterns}. Loaded: ${examples}${more}. ` +
    `Fix the patterns in .metaobjects/config.json (migrate.scope), or remove the key to ` +
    `govern everything loaded.`
  );
}
