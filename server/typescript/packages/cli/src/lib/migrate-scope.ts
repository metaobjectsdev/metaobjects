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
import type { SchemaProvenance } from "@metaobjectsdev/migrate-ts";

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
 * The refusal for a `migrate.scope` that matches NOTHING it could govern.
 *
 * A scope matching zero of the objects that declare a table or view can never be
 * what someone meant — it says "every table in this model belongs to somebody
 * else", which is a project with no schema to migrate at all, expressed the hard
 * way. In practice it is a typo'd or stale package pattern, or a scope over a
 * package that holds only value objects and abstracts (shapes that can never
 * contribute a table or view), and it is silent: migrate reports "no changes"
 * while having compared nothing.
 *
 * It is also actively dangerous, which is why this is a refusal and not a warning.
 * An empty expected side is what `diff` reads as "no model, govern the whole
 * database" — the inversion `scopeExpectedSchema`'s `declaredSchemas` closes
 * structurally (migrate-ts `scope.ts`). This is the second lock on the same door:
 * the structural fix stops a wrong scope proposing a destructive change, and this
 * stops the wrong scope going unnoticed in the first place.
 *
 * Returns the message to report, or `undefined` when there is nothing to refuse —
 * no scope declared, or at least one table- or view-declaring object inside it.
 * Callers report it and exit 2 (a configuration error), rather than this throwing,
 * so it reads like every other config failure in these commands.
 */
export function migrateScopeMismatch(
  collection: Collection,
  /**
   * The UNSCOPED expected schema's provenance (migrate-ts
   * `buildExpectedSchemaWithProvenance`) — qualified table/view name → declaring
   * FQN. Supplied lazily because it is consulted only under a declared scope, so
   * a project with no `migrate.scope` pays nothing for this check and its runs
   * are byte-for-byte what they always were.
   */
  provenance: () => SchemaProvenance,
): string | undefined {
  const { inMigrateScope, migrateScopePatterns } = collection;
  if (inMigrateScope === undefined) return undefined;

  // The declaring FQNs of every table and view the UNSCOPED model contributes —
  // the same provenance `scopeExpectedSchema` decides scope on, so the refusal
  // asks exactly the question the run answers. NOT the loaded object set: that
  // counts value objects and abstracts, which can never declare a table or view
  // (persistability derives from a declared/inherited writable source, never
  // from a subtype — #248), so a scope over only those objects passed this
  // refusal while governing zero tables. And not a fresh walk either: it would
  // have to re-implement the builder's skip rules (abstract, TPH subtype, no
  // writable source, `@unmanaged`) and would drift from them.
  const fqns = [...new Set(provenance().values())];
  // A model that declares no table or view at all is not a scope error: there is
  // nothing for a pattern to govern, scoped or not, and an empty schema has its
  // own (much louder) failure modes downstream.
  if (fqns.length === 0) return undefined;
  if (fqns.some(inMigrateScope)) return undefined;

  const patterns = JSON.stringify(migrateScopePatterns ?? []);
  const examples = fqns.slice(0, EXAMPLE_FQN_CAP).join(", ");
  const more = fqns.length > EXAMPLE_FQN_CAP ? `, …and ${fqns.length - EXAMPLE_FQN_CAP} more` : "";
  return (
    `migrate.scope matched none of the ${fqns.length} object(s) declaring a table or view, ` +
    `so this run would treat every one of them as another owner's and compare nothing. ` +
    `Patterns: ${patterns}. Declaring a table or view: ${examples}${more}. ` +
    `Fix the patterns in .metaobjects/config.json (migrate.scope), or remove the key to ` +
    `govern everything the model declares.`
  );
}
