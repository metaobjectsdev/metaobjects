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
//
// THE RULE THAT FOLLOWS FROM THAT, stated once because it is easy to read the other
// way: **a scope narrows which OBJECTS the tool governs, never which SCHEMAS it is
// allowed to see.** Pinning `scopeSchemas` to the unscoped model means a scope that
// excludes every declared object in schema `X` leaves `X` in scope, so another
// owner's UNDECLARED table in `X` stays a drop candidate — exactly as it would be on
// an unscoped run of the same model. That is deliberate: a schema this model
// declares into is a schema this model manages, and deriving the schema set from the
// survivors instead is precisely the inversion above. Declaring a scope is not a way
// to hand a schema over; removing the objects from the model is.
//
// `scopedDiffInputs` exists so no caller has to remember any of this: it returns all
// three obligations as one object, and every scoped `diff` call goes through it.

import { DEFAULT_DB_SCHEMA_POSTGRES } from "@metaobjectsdev/metadata";
import type { DiffArgs } from "./diff/index.js";
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
   * above. Reaches `diff`'s `unmanagedNames` (MERGED with `collectUnmanagedNames`,
   * never replacing it) so the actual side is suppressed too — `scopedDiffInputs`
   * does that merge; see the module header for why omitting it inverts the feature.
   */
  outOfScope: string[];
  /**
   * The database schemas the UNSCOPED model declares, for `diff`'s `scopeSchemas`.
   * `scopedDiffInputs` threads it — see the module header: without it a scope
   * matching nothing hands `diff` an empty expected side, which it reads as "no
   * model, govern the whole database".
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
  return {
    ...next,
    tables: [...next.tables, ...splitOnName(prior.tables, excluded).named],
    views: [...next.views, ...splitOnName(prior.views, excluded).named],
  };
}

/**
 * Drop the out-of-scope entries from a COMMITTED SNAPSHOT, producing the same
 * three-part shape `scopeExpectedSchema` produces so the result can go straight
 * through {@link scopedDiffInputs}.
 *
 * `verify`'s committed-snapshot gate (#292) needs this: `unmanagedNames` suppresses
 * only the ACTUAL side, which is right when the expected side is the metadata (it is
 * already scoped) and wrong here, where the expected side IS the snapshot — a
 * snapshot written before the scope was declared still carries the other owner's
 * tables, and leaving them in reports a phantom disagreement about an object this
 * consumer does not manage.
 *
 * `governed` is the scope decision the caller's drift comparison already made — pass
 * the `DriftResult` itself, which satisfies this shape. Taking `declaredSchemas`
 * from there rather than re-deriving it from the snapshot is what closes the last
 * whole-database door: a snapshot that is present but EMPTY (a never-migrated
 * project) declares no schemas at all, so deriving from it hands `diff` nothing and
 * reaches its "no model, govern the whole database" fallback — the very inversion
 * this module exists to prevent, at the one call site that was still re-deriving.
 *
 * An empty `outOfScope` returns the SAME snapshot object with no schema pin, so an
 * unscoped project's `diff` arguments are byte-for-byte what they always were.
 */
export function excludeFromSnapshot(
  snapshot: SchemaSnapshot,
  governed: GovernedScope,
): ScopedExpectedSchema {
  if (governed.outOfScope.length === 0) return { snapshot, outOfScope: [] };
  const excluded = new Set(governed.outOfScope);
  const declared = governed.declaredSchemas ?? declaredSchemasOf(snapshot);
  return {
    snapshot: {
      ...snapshot,
      tables: splitOnName(snapshot.tables, excluded).rest,
      views: splitOnName(snapshot.views, excluded).rest,
    },
    outOfScope: [...governed.outOfScope],
    declaredSchemas: [...declared],
  };
}

/** The scope decision a run made, as `DriftResult` reports it. */
export interface GovernedScope {
  /** Qualified physical names (`<schema>.<name>`) the run does not govern. */
  readonly outOfScope: readonly string[];
  /** The schemas the run governs — `ScopedExpectedSchema.declaredSchemas`. */
  readonly declaredSchemas?: readonly string[] | undefined;
}

/**
 * Partition `objs` on whether `qualifiedDbName(o)` is in `names`.
 *
 * `carryForwardOutOfScope` wants the `named` half (carry the excluded entries
 * forward) and `excludeFromSnapshot` wants the `rest` half (drop them). They are
 * exact complements over the same key function, so they share one traversal rather
 * than two filters that could come to key differently.
 */
function splitOnName<T extends { name: string; schema?: string }>(
  objs: readonly T[],
  names: ReadonlySet<string>,
): { named: T[]; rest: T[] } {
  const named: T[] = [];
  const rest: T[] = [];
  for (const o of objs) (names.has(qualifiedDbName(o)) ? named : rest).push(o);
  return { named, rest };
}

/**
 * The three `diff` arguments a scoped run owes, as ONE value.
 *
 * The module header lists them as three separate obligations, and five call sites
 * re-derived them by hand — one of which had already drifted into its own guard.
 * Every scoped `diff` call is now
 * `diff({ ...scopedDiffInputs(scoped, collectUnmanagedNames(metadata)), actual, ... })`,
 * so the rule is enforced by the type rather than by the comment.
 *
 * `unmanaged` is the `@unmanaged`-declared set (`collectUnmanagedNames`); it is
 * MERGED with `outOfScope`, never replaced by it — both must reach `diff`.
 * `scopeSchemas` is omitted entirely when the run narrowed nothing, so an unscoped
 * project's arguments are unchanged.
 */
export function scopedDiffInputs(
  scoped: ScopedExpectedSchema,
  unmanaged: readonly string[],
): Pick<DiffArgs, "expected" | "unmanagedNames" | "scopeSchemas"> {
  return {
    expected: scoped.snapshot,
    unmanagedNames: [...unmanaged, ...scoped.outOfScope],
    ...(scoped.declaredSchemas !== undefined ? { scopeSchemas: scoped.declaredSchemas } : {}),
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
