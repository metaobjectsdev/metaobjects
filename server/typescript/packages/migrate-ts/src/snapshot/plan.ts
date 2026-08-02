// src/snapshot/plan.ts
import type { ColumnNamingStrategy, MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../expected-schema.js";
import { diff, type DiffArgs } from "../diff/index.js";
import { collectUnmanagedNames } from "../unmanaged.js";
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
}

export interface PlanOfflineResult {
  /** The change set to emit, from diffing metadata-expected against the snapshot. */
  diff: DiffResult;
  /** The schema the migration brings us to — write this back as the new snapshot on accept. */
  nextSnapshot: SchemaSnapshot;
}

/**
 * Plan a migration offline: build the expected schema from metadata and diff it
 * against the stored snapshot. No database. The caller emits `diff` and, on
 * accept, persists `nextSnapshot` via writeSnapshot.
 */
export async function planOffline(args: PlanOfflineArgs): Promise<PlanOfflineResult> {
  const nextSnapshot = buildExpectedSchema(args.metadata, {
    dialect: args.dialect,
    ...(args.columnNamingStrategy ? { columnNamingStrategy: args.columnNamingStrategy } : {}),
    ...(args.views !== undefined ? { views: args.views } : {}),
  });
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
    unmanagedNames: collectUnmanagedNames(args.metadata),
    ...(args.allow ? { allow: args.allow } : {}),
    ...(args.onAmbiguous ? { onAmbiguous: args.onAmbiguous } : {}),
    ...(args.ignoreTables ? { ignoreTables: args.ignoreTables } : {}),
  });
  return { diff: result, nextSnapshot };
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
