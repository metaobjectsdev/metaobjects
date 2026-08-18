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
import { scopeExpectedSchema, type ObjectScopePredicate } from "../scope.js";
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
}

export interface DriftResult extends DiffResult {
  /**
   * Qualified physical names excluded by `inScope` — empty when no scope was
   * given. The caller REPORTS these: an object silently dropped from the
   * comparison is indistinguishable from one that was checked and found clean.
   */
  outOfScope: readonly string[];
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
  );
  const result = await diff({
    expected: scoped.snapshot,
    actual,
    dialect,
    allow: opts?.allow ?? {},
    // #208 §7 — a declared-@unmanaged object is external, so it is not drift: exclude it
    // from the actual side (same as `meta migrate`) rather than surface a false drop-*.
    // Out-of-scope objects join it: dropping them from `expected` alone would turn each
    // one that EXISTS in the database into a spurious drop-* drift.
    unmanagedNames: [...collectUnmanagedNames(metadata), ...scoped.outOfScope],
    ...(opts?.ignoreTables !== undefined ? { ignoreTables: opts.ignoreTables } : {}),
  });
  return { ...result, outOfScope: scoped.outOfScope };
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
