// src/snapshot/plan.ts
import type { ColumnNamingStrategy, MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema, buildExpectedSchemaWithProvenance } from "../expected-schema.js";
import { diff, type DiffArgs } from "../diff/index.js";
import { collectUnmanagedNames } from "../unmanaged.js";
import { carryForwardOutOfScope, scopeExpectedSchema, scopedDiffInputs, type ObjectScopePredicate } from "../scope.js";
import type { Dialect, DiffResult, SchemaSnapshot } from "../types.js";
import type { ExpectedViewInput } from "../expected-schema.js";

export interface PlanOfflineArgs extends Pick<DiffArgs, "allow" | "onAmbiguous" | "ignoreTables"> {
  metadata: MetaData;
  dialect: Dialect;
  /** The stored reference snapshot (the "from" side). Use `{ tables: [], views: [] }` for a fresh project. */
  snapshot: SchemaSnapshot;
  columnNamingStrategy?: ColumnNamingStrategy;
  /** Expected views (via codegen-ts `buildProjectionViews`) — threaded into buildExpectedSchema. */
  views?: readonly ExpectedViewInput[];
  /**
   * Per-command scope (`migrate.scope`): objects whose declaring FQN this predicate
   * rejects are governed by somebody else. They leave the expected side (so no
   * create/alter) AND the snapshot side (so no drop). Omit to govern everything
   * loaded (unchanged behavior).
   */
  inScope?: ObjectScopePredicate;
}

export interface PlanOfflineResult {
  /** The change set to emit, from diffing metadata-expected against the snapshot. */
  diff: DiffResult;
  /**
   * The schema the migration brings us to — write this back as the new snapshot on
   * accept. Under a scope this is the governed schema PLUS the out-of-scope entries
   * the prior snapshot held: committing the narrowed schema would delete them, and a
   * later widening would then propose CREATE TABLE for a table that exists.
   */
  nextSnapshot: SchemaSnapshot;
  /**
   * The governed (narrowed) expected side — what the diff compared and what the
   * emitter renders against. Identical to `nextSnapshot` for an unscoped run; under
   * a scope it is deliberately the SMALLER of the two, since a run must emit DDL
   * only for what it governs.
   */
  expected: SchemaSnapshot;
  /** Qualified physical names excluded by `inScope`; empty when no scope was given. */
  outOfScope: readonly string[];
}

/**
 * Plan a migration offline: build the expected schema from metadata and diff it
 * against the stored snapshot. No database. The caller emits `diff` and, on
 * accept, persists `nextSnapshot` via writeSnapshot.
 */
export async function planOffline(args: PlanOfflineArgs): Promise<PlanOfflineResult> {
  const scoped = scopeExpectedSchema(
    buildExpectedSchemaWithProvenance(args.metadata, {
      dialect: args.dialect,
      ...(args.columnNamingStrategy ? { columnNamingStrategy: args.columnNamingStrategy } : {}),
      ...(args.views !== undefined ? { views: args.views } : {}),
    }),
    args.inScope,
  );
  // The DIFF runs against the narrowed side; the SNAPSHOT keeps what this run
  // excluded. Committing the narrowed schema would delete every out-of-scope entry
  // the previous snapshot held, so removing or widening `migrate.scope` later would
  // propose CREATE TABLE for a table that exists and fail at apply. Byte-identical
  // for an unscoped run (`outOfScope` empty ⇒ the same object).
  const nextSnapshot = carryForwardOutOfScope(scoped.snapshot, args.snapshot, scoped.outOfScope);
  const result = await diff({
    // The three scoped-diff obligations as one value (see scope.ts's header). The
    // `unmanagedNames` merge matters as much on the OFFLINE path as anywhere: an
    // out-of-scope table already recorded in the snapshot must not be dropped just
    // because the scope excludes it, and neither must a declared-@unmanaged one a
    // `baseline --from-db` captured (#208 §7).
    ...scopedDiffInputs(scoped, collectUnmanagedNames(args.metadata)),
    actual: args.snapshot,
    dialect: args.dialect,
    // #258 — migration generation refuses a primary-key MOVE (there is no primary-key
    // change kind to express it; it would otherwise silently drop the constraint). The
    // read-only verify/drift path does NOT set this, so `meta verify` still reports drift.
    refusePrimaryKeyChange: true,
    ...(args.allow ? { allow: args.allow } : {}),
    ...(args.onAmbiguous ? { onAmbiguous: args.onAmbiguous } : {}),
    ...(args.ignoreTables ? { ignoreTables: args.ignoreTables } : {}),
  });
  return { diff: result, nextSnapshot, expected: scoped.snapshot, outOfScope: scoped.outOfScope };
}

/** Seed an initial reference snapshot from metadata (greenfield baseline). */
export function baselineFromMetadata(
  metadata: MetaData,
  dialect: Dialect,
  columnNamingStrategy?: ColumnNamingStrategy,
  views?: readonly ExpectedViewInput[],
): SchemaSnapshot {
  return buildExpectedSchema(metadata, {
    dialect,
    ...(columnNamingStrategy ? { columnNamingStrategy } : {}),
    ...(views !== undefined ? { views } : {}),
  });
}
