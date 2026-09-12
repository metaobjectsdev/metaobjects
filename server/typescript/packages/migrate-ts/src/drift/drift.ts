// computeDrift — structural + view-body drift of a live DB vs the metadata-
// declared schema. Thin composition over the existing pipeline:
//   buildExpectedSchema(metadata) + introspect(db, dialect) → diff(...)
//
// Used by the `meta verify --db` schema-drift gate: a non-empty `changes` list
// means the live DB has diverged from what the metadata describes (a missing
// column, a changed view body, an extra table, etc.). Unlike `meta migrate`,
// drift detection never emits SQL or asks about ambiguous renames — it just
// reports the divergence so CI can fail loud.
//
// computeDriftFromActual (#225) is the post-introspection half, factored out so
// `meta verify --d1` can drive the same expected-schema + diff pipeline from a
// SchemaSnapshot obtained via `introspectD1` (wrangler-shelled-out) instead of a
// Kysely driver — D1 has no client wire protocol, so `introspect()` can't reach it.

import type { Kysely } from "kysely";
import type { MetaRoot } from "@metaobjectsdev/metadata";
import type { ColumnNamingStrategy } from "@metaobjectsdev/metadata";
import { buildExpectedSchemaWithProvenance } from "../expected-schema.js";
import { introspect } from "../introspect/index.js";
import { diff } from "../diff/index.js";
import { collectUnmanagedNames } from "../unmanaged.js";
import { scopeExpectedSchema, scopedDiffInputs, type ObjectScopePredicate } from "../scope.js";
import type { AllowOptions, Dialect, DiffResult, SchemaSnapshot } from "../types.js";

export interface ComputeDriftOptions {
  /**
   * Destructive-change permissions. Mirrors `diff`'s `allow` — a drift that is
   * "allowed" still appears in `changes` (it's still drift), so the gate fails
   * on it. `allow` only affects `blocked`. Defaults to `{}`.
   */
  allow?: AllowOptions;
  /**
   * Column-naming strategy for fields with no `@column` override. Must match
   * the runtime's strategy or the expected schema's columns won't line up with
   * what introspection sees. Defaults to `buildExpectedSchema`'s default.
   */
  columnNamingStrategy?: ColumnNamingStrategy;
  /**
   * Table-name patterns to ignore on both sides (passed through to `diff`).
   * Omit to keep `diff`'s default (migration-tracking sidecar tables).
   */
  ignoreTables?: string[];
  /**
   * Expected views (projection → CREATE VIEW body), computed by the caller via
   * codegen-ts's `buildProjectionViews`. migrate-ts no longer generates view DDL
   * itself; pass these so view drift is detected. Defaults to none.
   */
  views?: readonly import("../expected-schema.js").ExpectedViewInput[];
  /**
   * Per-command scope (`migrate.scope`): objects whose declaring FQN this predicate
   * rejects are governed by somebody else. They leave the expected side AND are
   * suppressed on the actual side, so their divergence is neither drift nor a
   * proposed drop — `verify` reports them as out-of-scope instead (see
   * `DriftResult.outOfScope`). Omit to govern everything loaded (unchanged behavior).
   *
   * `verify --db` and `migrate` deliberately share ONE declaration: a drift gate
   * failing on tables migrate does not own is incoherent.
   */
  inScope?: ObjectScopePredicate;
  /**
   * FR-023 — objects a DEPENDENCY owns. Such an object is loaded so this project's own
   * model can resolve against it and is governed by nobody here unless `inScope`
   * admits it: it leaves the expected side, is suppressed on the actual side, and —
   * unlike an `inScope` exclusion — takes the publisher's database schema out of the
   * run's scope with it, so a table the publisher never exported is not reported as an
   * extra table in a schema this project does not manage (migrate-ts `scope.ts`).
   *
   * `verify --db` and `migrate` share this declaration for the same reason they share
   * `inScope`. Omit for a project with no dependencies (unchanged behavior).
   */
  imported?: ObjectScopePredicate;
}

export interface DriftResult extends DiffResult {
  /**
   * Qualified physical names excluded by `inScope` — empty when no scope was
   * given. The caller REPORTS these: an object silently dropped from the
   * comparison is indistinguishable from one that was checked and found clean.
   */
  outOfScope: readonly string[];
  /**
   * The schemas this comparison governed (`ScopedExpectedSchema.declaredSchemas`),
   * `undefined` when no scope was given and `diff` derived its own.
   *
   * Reported so a SECOND comparison over the same run — `verify`'s committed-snapshot
   * gate — can govern exactly the same schemas instead of re-deriving them from a
   * different expected side. Together with `outOfScope` this pair is a
   * `GovernedScope`, which is what `excludeFromSnapshot` takes.
   */
  declaredSchemas: readonly string[] | undefined;
  /**
   * The subset of `outOfScope` a DEPENDENCY contributed (FR-023). Reported for the
   * same reason `declaredSchemas` is: so the caller states WHY an object was left out
   * without re-deriving the decision from a second expected-schema build, which could
   * come to disagree with the one this comparison actually made.
   */
  importedOutOfScope: readonly string[] | undefined;
}

/**
 * Compute the drift between an ALREADY-INTROSPECTED schema snapshot and the
 * metadata-declared schema. The post-introspection half of `computeDrift`,
 * factored out so a caller that can't use `introspect()`'s Kysely-driver path
 * (there is none for Cloudflare D1 — it has no client wire protocol) can still
 * run the same expected-schema + diff pipeline against a snapshot it obtained
 * some other way (e.g. `introspectD1` over a wrangler-shelled-out runner).
 *
 * Returns a `DiffResult` whose `changes` is empty iff `actual` matches the
 * metadata. The caller decides exit behavior (the schema-drift gate fails when
 * `changes` is non-empty).
 */
export async function computeDriftFromActual(
  actual: SchemaSnapshot,
  dialect: Dialect,
  metadata: MetaRoot,
  opts?: ComputeDriftOptions,
): Promise<DriftResult> {
  const scoped = scopeExpectedSchema(
    buildExpectedSchemaWithProvenance(metadata, {
      dialect,
      ...(opts?.columnNamingStrategy !== undefined
        ? { columnNamingStrategy: opts.columnNamingStrategy }
        : {}),
      ...(opts?.views !== undefined ? { views: opts.views } : {}),
    }),
    opts?.inScope,
    opts?.imported !== undefined ? { imported: opts.imported } : undefined,
  );
  const result = await diff({
    // The three scoped-diff obligations as one value (see scope.ts's header):
    // the narrowed expected side, `unmanagedNames` merging @unmanaged with the
    // out-of-scope names so neither is proposed for drop, and the schema scope
    // pinned to the UNSCOPED model so a narrow scope can never widen the run.
    ...scopedDiffInputs(scoped, collectUnmanagedNames(metadata)),
    actual,
    dialect,
    allow: opts?.allow ?? {},
    ...(opts?.ignoreTables !== undefined ? { ignoreTables: opts.ignoreTables } : {}),
  });
  return {
    ...result,
    outOfScope: scoped.outOfScope,
    declaredSchemas: scoped.declaredSchemas,
    importedOutOfScope: scoped.importedOutOfScope,
  };
}

/**
 * Compute the drift between a live DB and the metadata-declared schema.
 *
 * Thin wrapper: introspects `db` via the Kysely-driver path, then delegates to
 * `computeDriftFromActual`. Signature and behavior are unchanged by the #225
 * refactor above — existing callers are unaffected.
 */
export async function computeDrift(
  db: Kysely<Record<string, unknown>>,
  dialect: Dialect,
  metadata: MetaRoot,
  opts?: ComputeDriftOptions,
): Promise<DriftResult> {
  const actual = await introspect(db, dialect);
  return computeDriftFromActual(actual, dialect, metadata, opts);
}
