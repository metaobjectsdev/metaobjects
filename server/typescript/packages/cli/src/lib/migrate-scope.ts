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

import { matchesScope, type CompiledScope } from "@metaobjectsdev/sdk";
import type { ObjectScopePredicate } from "@metaobjectsdev/migrate-ts";

/**
 * Adapt a compiled `migrate.scope` to migrate-ts's predicate seam. Undefined in,
 * undefined out — a project that declared no scope governs everything it loaded,
 * and the undefined predicate is what keeps its expected schema untouched.
 */
export function toObjectScope(scope: CompiledScope | undefined): ObjectScopePredicate | undefined {
  return scope === undefined ? undefined : (fqn: string): boolean => matchesScope(fqn, scope);
}
