// src/snapshot/plan.ts
import type { ColumnNamingStrategy, MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema, buildExpectedSchemaWithProvenance } from "../expected-schema.js";
import { diff, type DiffArgs } from "../diff/index.js";
import { collectUnmanagedNames } from "../unmanaged.js";
import { scopeExpectedSchema, type ObjectScopePredicate } from "../scope.js";
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
  /** The schema the migration brings us to — write this back as the new snapshot on accept. */
  nextSnapshot: SchemaSnapshot;
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
  const nextSnapshot = scoped.snapshot;
  const result = await diff({
    expected: nextSnapshot,
    actual: args.snapshot,
    dialect: args.dialect,
    // #258 — migration generation refuses a primary-key MOVE (there is no primary-key
    // change kind to express it; it would otherwise silently drop the constraint). The
    // read-only verify/drift path does NOT set this, so `meta verify` still reports drift.
    refusePrimaryKeyChange: true,
    // #208 §7 — exclude declared-@unmanaged objects from the actual (snapshot) side too,
    // so the OFFLINE generate path never proposes DROP for an external table that a
    // `baseline --from-db` captured into the snapshot (parity with the online/verify paths).
    // Out-of-scope objects join them, for the same reason: an out-of-scope table already
    // recorded in the snapshot must not be dropped just because the scope excludes it.
    unmanagedNames: [...collectUnmanagedNames(args.metadata), ...scoped.outOfScope],
    // Pin the schema scope to the UNSCOPED model's schemas (see scope.ts's header):
    // a `migrate.scope` matching nothing would otherwise empty `expected`, which
    // `diff` reads as "no model, govern the whole database" — turning the
    // declaration that exists to protect another owner's tables into a proposed DROP
    // for them. Absent when no scope was given, so an unscoped run is unchanged.
    ...(scoped.declaredSchemas !== undefined ? { scopeSchemas: scoped.declaredSchemas } : {}),
    ...(args.allow ? { allow: args.allow } : {}),
    ...(args.onAmbiguous ? { onAmbiguous: args.onAmbiguous } : {}),
    ...(args.ignoreTables ? { ignoreTables: args.ignoreTables } : {}),
  });
  return { diff: result, nextSnapshot, outOfScope: scoped.outOfScope };
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
