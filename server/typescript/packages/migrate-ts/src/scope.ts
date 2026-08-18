// Per-command scope — narrowing a migrate/verify run to the objects it governs.
//
// A consumer sharing a database with another owner declares
// `"migrate": { "scope": ["acme::platform::**"] }`. Tables and views outside that
// scope are neither created nor dropped, which takes TWO suppressions:
//
//   1. drop them from the EXPECTED side, so nothing is created or altered;
//   2. suppress the same names on the ACTUAL side (via `diff`'s `unmanagedNames`,
//      the seam `@unmanaged` already uses), so nothing is dropped.
//
// Doing only (1) is strictly worse than doing nothing: every out-of-scope table that
// EXISTS in the database becomes a proposed `DROP TABLE` — the precise hazard this
// feature exists to remove. `scopeExpectedSchema` therefore returns both halves and
// callers must thread `outOfScope` into the diff.

import type { ExpectedSchemaWithProvenance } from "./expected-schema.js";
import { qualifiedDbName } from "./qualified-name.js";
import type { SchemaSnapshot } from "./types.js";

/**
 * Decides whether an object's fully-qualified name (`resolutionKey()`) is governed
 * by this run. Supplied by the caller as a PREDICATE so migrate-ts never carries a
 * second implementation of the scope-pattern grammar — `matchesScope` in
 * `@metaobjectsdev/sdk` is the only one, and the CLI adapts a compiled scope to
 * this seam.
 */
export type ObjectScopePredicate = (fqn: string) => boolean;

export interface ScopedExpectedSchema {
  /** The expected schema narrowed to the governed objects. */
  snapshot: SchemaSnapshot;
  /**
   * Qualified physical names (`<schema>.<name>`) of the tables and views removed
   * above. MUST be threaded into `diff`'s `unmanagedNames` (merged with
   * `collectUnmanagedNames`, never replacing it) so the actual side is suppressed
   * too — see the module header.
   */
  outOfScope: string[];
}

/**
 * Narrow an expected schema to the objects inside `inScope`.
 *
 * An undefined predicate returns the input untouched — the SAME snapshot object,
 * not an equal copy — so a project that declares no `migrate.scope` reaches the
 * diff, the emitter and the committed snapshot through an unchanged value.
 *
 * A table or view with NO recorded provenance is KEPT. Scope decides on the
 * declaring object's FQN, and an object whose FQN is unknown was never proven to be
 * anyone else's; dropping it would silently un-manage it (and, worse, suppressing
 * its name on the actual side would hide real drift).
 */
export function scopeExpectedSchema(
  built: ExpectedSchemaWithProvenance,
  inScope: ObjectScopePredicate | undefined,
): ScopedExpectedSchema {
  if (inScope === undefined) return { snapshot: built.snapshot, outOfScope: [] };

  const outOfScope: string[] = [];
  const governed = <T extends { name: string; schema?: string }>(obj: T): boolean => {
    const qualified = qualifiedDbName(obj);
    const fqn = built.provenance.get(qualified);
    if (fqn === undefined || inScope(fqn)) return true;
    outOfScope.push(qualified);
    return false;
  };

  return {
    snapshot: {
      ...built.snapshot,
      tables: built.snapshot.tables.filter(governed),
      views: built.snapshot.views.filter(governed),
    },
    outOfScope,
  };
}
