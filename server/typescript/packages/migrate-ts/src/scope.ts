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
//
// There is a THIRD half, and it is the one that bites hardest when the scope is
// wrong. `diff` derives its SCHEMA scope from the schemas the expected side
// mentions, falling back to "no schema scoping at all" when expected is empty (the
// legacy whole-DB path for a project with no model). A scope matching NOTHING
// empties `expected`, reaches that fallback, and every actual table in every schema
// becomes a drop candidate — another owner's included, which was never in `expected`
// so it has no provenance and never lands in `outOfScope`. Narrowing must never
// WIDEN. `declaredSchemas` below reports the UNSCOPED model's schemas so callers can
// pin `diff`'s `scopeSchemas` to a property of the whole model, which `migrate.scope`
// then cannot move in either direction.

import { DEFAULT_DB_SCHEMA_POSTGRES } from "@metaobjectsdev/metadata";
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
  /**
   * The database schemas the UNSCOPED model declares, for `diff`'s `scopeSchemas`.
   * MUST be threaded there by every caller that narrows — see the module header:
   * without it a scope matching nothing hands `diff` an empty expected side, which
   * it reads as "no model, govern the whole database".
   *
   * `undefined` when no predicate was supplied (so `diff` derives its own set from
   * an untouched `expected`, exactly as before — an unscoped project's arguments are
   * unchanged) and also when the unscoped model declares no tables or views at all
   * (nothing to derive from; `diff`'s legacy whole-DB fallback is preserved).
   */
  declaredSchemas?: string[];
}

/**
 * Carry an out-of-scope object forward into the snapshot a run is about to commit.
 *
 * The committed snapshot is built from the metadata-expected schema, which a scoped
 * run has already narrowed — so accepting a scoped run DELETES every out-of-scope
 * entry the previous snapshot held. Widening or removing `migrate.scope` later then
 * proposes `CREATE TABLE` for a table that exists, and the migration fails at apply.
 *
 * `prior` is the snapshot (or introspected schema) the run diffed against, and the
 * entries taken from it are exactly the ones this run excluded — nothing else is
 * carried, so a table the model never declared is unaffected either way. An empty
 * `outOfScope` returns the SAME object, so an unscoped run commits a byte-identical
 * snapshot.
 */
export function carryForwardOutOfScope(
  next: SchemaSnapshot,
  prior: SchemaSnapshot,
  outOfScope: readonly string[],
): SchemaSnapshot {
  if (outOfScope.length === 0) return next;
  const excluded = new Set(outOfScope);
  const keep = <T extends { name: string; schema?: string }>(objs: readonly T[]): T[] =>
    objs.filter((o) => excluded.has(qualifiedDbName(o)));
  return {
    ...next,
    tables: [...next.tables, ...keep(prior.tables)],
    views: [...next.views, ...keep(prior.views)],
  };
}

/**
 * The distinct database schemas a snapshot's tables and views sit in, absent
 * normalized to the Postgres default — the value `diff` derives for itself when no
 * `scopeSchemas` is supplied. The ONE definition: any caller narrowing an expected
 * side must pin `diff`'s schema scope to the UNNARROWED snapshot's schemas, and a
 * second encoding of "absent means public" here would silently disagree with the
 * one inside `diff`.
 *
 * Empty in ⇒ empty out, which callers translate to "pass nothing", preserving
 * `diff`'s legacy whole-database fallback for a genuinely empty model.
 */
export function declaredSchemasOf(snapshot: SchemaSnapshot): string[] {
  return [
    ...new Set(
      [...snapshot.tables, ...snapshot.views].map(
        (o) => o.schema ?? DEFAULT_DB_SCHEMA_POSTGRES,
      ),
    ),
  ].sort();
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

  // Computed from `built.snapshot` — the UNSCOPED side — deliberately, and before
  // the filter below runs. Deriving it from the survivors would reproduce exactly
  // the defect this exists to close.
  const declared = declaredSchemasOf(built.snapshot);

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
    ...(declared.length > 0 ? { declaredSchemas: declared } : {}),
  };
}
