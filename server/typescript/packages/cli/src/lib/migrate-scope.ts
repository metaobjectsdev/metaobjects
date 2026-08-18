// The one adapter between a declared `migrate.scope` and migrate-ts's scope seam.
//
// `resolveCollection` compiles `.metaobjects/config.json`'s `migrate.scope` into a
// `CompiledScope`; migrate-ts takes a plain predicate over an object's
// fully-qualified name so it never carries a second implementation of the pattern
// grammar. `matchesScope` (@metaobjectsdev/sdk) is THE pattern engine — there is no
// other, and adding one would let `migrate` and `gen` disagree about what
// `acme::platform::**` means.
//
// Both `meta migrate` and `meta verify --db` import this: the two commands govern
// the identical object set, so they share the one declaration rather than each
// growing a key of its own.

import { matchesScope, type Collection, type CompiledScope } from "@metaobjectsdev/sdk";
import type { MetaRoot } from "@metaobjectsdev/metadata";
import type { ObjectScopePredicate } from "@metaobjectsdev/migrate-ts";

/**
 * Adapt a compiled `migrate.scope` to migrate-ts's predicate seam. Undefined in,
 * undefined out — a project that declared no scope governs everything it loaded,
 * and the undefined predicate is what keeps its expected schema untouched.
 */
export function toObjectScope(scope: CompiledScope | undefined): ObjectScopePredicate | undefined {
  return scope === undefined ? undefined : (fqn: string): boolean => matchesScope(fqn, scope);
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
  const { migrateScope, migrateScopePatterns } = collection;
  if (migrateScope === undefined) return undefined;

  // ADR-0039: `objects()` is the resolving accessor — the loaded object set, which
  // is exactly what `migrate.scope` claims to be a subset of.
  const fqns = root.objects().map((o) => o.resolutionKey());
  // No objects at all is not a scope error: there is nothing for a pattern to miss,
  // and an empty model has its own (much louder) failure modes downstream.
  if (fqns.length === 0) return undefined;
  if (fqns.some((fqn) => matchesScope(fqn, migrateScope))) return undefined;

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
